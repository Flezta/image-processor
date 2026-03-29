import {onObjectFinalized} from "firebase-functions/v2/storage";
import * as admin from "firebase-admin";
import mongoose from "mongoose";
import sharp from "sharp";
import path from "path";
import os from "os";
import fs from "fs/promises";
import dotenv from "dotenv";

dotenv.config();

// ---------- Config ----------
const MAX_FILE_SIZE_MB = 10;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 300;
const ALLOWED_FORMATS = ["jpeg", "png", "webp", "avif"];

const IMAGE_SIZES = {
  thumbnail: 200,
  medium: 800,
  large: 1500,
};

// ---------- Firebase ----------
admin.initializeApp();
const storage = admin.storage().bucket(process.env.BUCKET_NAME);

// ---------- Mongo ----------
let mongoConnected = false;

async function connectMongo() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI not set");
  }
  if (!mongoConnected) {
    await mongoose.connect(process.env.MONGO_URI);
    mongoConnected = true;
  }
}

// ---------- Models ----------
const Product = mongoose.model(
  "Product",
  new mongoose.Schema(
    {
      productId: String,
      variantProperties: {type: Object, default: {}},
      images: [],
    },
    {collection: "products"},
  ),
);

// ---------- Helpers ----------

async function moveToDeadLetter(filePath: string) {
  try {
    const fileName = path.basename(filePath);
    const random = Math.floor(100 + Math.random() * 900);
    const destination = `dead-letter/${random}_${fileName}`;

    await storage.file(filePath).setMetadata({
      metadata: {status: "dead-letter"},
    });

    await storage.file(filePath).move(destination);

    console.warn("Moved to dead-letter:", destination);
  } catch (err) {
    console.error("Dead-letter failed:", err);
  }
}

function extractMetadata(event: any) {
  const filePath = event.data.name;
  const metadata = event.data.metadata || {};

  return {
    filePath,
    productId: metadata.productId || metadata.productid,
    color: metadata.color,
    metadata,
  };
}

function shouldSkip(filePath: string, metadata: any) {
  if (!filePath) return true;
  if (filePath.includes("products/") || filePath.includes("dead-letter/")) {
    return true;
  }
  if (metadata?.processed === "true") return true;
  return false;
}

async function validateProduct(productId: string, color: string) {
  const product = await Product.findOne({productId});

  if (!product) throw new Error("PRODUCT_NOT_FOUND");

  const colorAxis = Object.keys(product.variantProperties).find(
    (k) => k.toLowerCase() === "color" || k.toLowerCase() === "colour",
  );

  if (!colorAxis) throw new Error("COLOR_AXIS_NOT_FOUND");

  const allowedColors = product.variantProperties[colorAxis] || [];

  if (!allowedColors.includes(color)) {
    throw new Error("INVALID_COLOR");
  }

  return product;
}

async function downloadFile(filePath: string, tempPath: string) {
  await storage.file(filePath).download({destination: tempPath});
}

async function validateImage(tempPath: string) {
  // Size check
  const stats = await fs.stat(tempPath);
  const sizeMB = stats.size / (1024 * 1024);

  if (sizeMB > MAX_FILE_SIZE_MB) {
    throw new Error("FILE_TOO_LARGE");
  }

  // Metadata check
  let metadata;
  try {
    metadata = await sharp(tempPath).metadata();
  } catch {
    throw new Error("INVALID_IMAGE");
  }

  if (!metadata.format || !ALLOWED_FORMATS.includes(metadata.format)) {
    throw new Error("UNSUPPORTED_FORMAT");
  }

  if (
    (metadata.width || 0) < MIN_WIDTH ||
    (metadata.height || 0) < MIN_HEIGHT
  ) {
    throw new Error("IMAGE_TOO_SMALL");
  }

  return metadata;
}

async function processAndUploadImages(
  tempInput: string,
  fileName: string,
  productId: string,
) {
  const urls: any = {};

  for (const [key, width] of Object.entries(IMAGE_SIZES)) {
    const outputName = `${path.parse(fileName).name}_${width}.jpg`;
    const tempOutput = path.join(os.tmpdir(), outputName);

    await sharp(tempInput)
      .resize(width, width, {fit: "inside", withoutEnlargement: true})
      .jpeg({quality: 85})
      .toFile(tempOutput);

    const destination = `products/${productId}/${outputName}`;

    await storage.upload(tempOutput, {
      destination,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        processed: "true",
      },
    });

    urls[key] =
      `https://storage.googleapis.com/${process.env.BUCKET_NAME}/${destination}`;

    await fs.unlink(tempOutput);
  }

  return urls;
}

async function updateProductImages(
  product: any,
  productId: string,
  fileName: string,
  urls: any,
  color: string,
) {
  const hasDefault = product.images?.some((img: any) => img.isDefault);

  const newImage = {
    name: fileName,
    sizes: urls,
    isDefault: !hasDefault,
    attributes: {color},
  };

  await Product.updateOne({productId}, {$push: {images: newImage}});
}

// ---------- Main Function ----------

export const processProductImage = onObjectFinalized(
  {
    bucket: process.env.BUCKET_NAME,
    region: process.env.REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    console.log("Event received:", event.data.name);
    const {filePath, productId, color, metadata} = extractMetadata(event);

    if (shouldSkip(filePath, metadata)) return;

    if (!productId || !color) {
      console.error("Missing metadata:", filePath);
      return moveToDeadLetter(filePath);
    }

    const fileName = path.basename(filePath);
    const tempInput = path.join(os.tmpdir(), fileName);

    try {
      await connectMongo();
      console.log("Connected to MongoDB");
      const product = await validateProduct(productId, color);

      await downloadFile(filePath, tempInput);

      await validateImage(tempInput);

      const urls = await processAndUploadImages(tempInput, fileName, productId);

      await storage.file(filePath).delete();
      await fs.unlink(tempInput);

      await updateProductImages(product, productId, fileName, urls, color);

      console.log("Processed:", fileName);
    } catch (err: any) {
      console.error("Processing failed:", err.message);
      await moveToDeadLetter(filePath);
    }
  },
);
