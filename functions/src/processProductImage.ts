import {onObjectFinalized} from "firebase-functions/v2/storage";
import * as admin from "firebase-admin";
import mongoose from "mongoose";
import sharp from "sharp";
import path from "path";
import os from "os";
import fs from "fs/promises";
import dotenv from "dotenv";

dotenv.config();

// ---------- Interfaces ----------
export interface ProductImageSizes {
  thumbnail: string; // 200px
  medium: string; // 800px
  large: string; // 1500px
}

export interface ProductImage {
  name: string;
  sizes: ProductImageSizes;
  isDefault?: boolean;
  order?: number;
  attributes: { color: string };
}

export interface ProductDocument extends mongoose.Document {
  productId: string;
  variantProperties: Record<string, string[]>;
  images: ProductImage[];
}

// ---------- Env ----------
const MONGO_URI = process.env.MONGO_URI;
const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;

if (!MONGO_URI || !BUCKET_NAME || !REGION) {
  throw new Error(
    "Missing required environment variables: MONGO_URI, BUCKET_NAME, and REGION",
  );
}

// ---------- Firebase ----------
admin.initializeApp();
const storage = admin.storage().bucket(BUCKET_NAME);

// ---------- Mongo Connection ----------
let mongoConnected = false;

/**
 * Connects to MongoDB if not already connected.
 */
async function connectMongo(): Promise<void> {
  if (!mongoConnected) {
    if (!MONGO_URI) {
      throw new Error("MONGO_URI is not defined in environment variables");
    }
    await mongoose.connect(MONGO_URI);
    mongoConnected = true;
  }
}

// ---------- Product Schema ----------
const ProductSchema = new mongoose.Schema(
  {
    productId: String,
    variantProperties: {type: Object, default: {}},
    images: [
      {
        name: String,
        sizes: {
          thumbnail: String,
          medium: String,
          large: String,
        },
        isDefault: Boolean,
        attributes: {color: String},
      },
    ],
  },
  {collection: "products"},
);

const Product = mongoose.model<ProductDocument>("Product", ProductSchema);

// ---------- Image Sizes ----------
const IMAGE_SIZES: Record<keyof ProductImageSizes, number> = {
  thumbnail: 200,
  medium: 800,
  large: 1500,
};

// ---------- Dead-Letter Handler ----------
/**
 * Moves a file to the dead-letter folder when processing fails.
 * @param filePath Path of the file to move
 */
async function moveToDeadLetter(filePath: string): Promise<void> {
  try {
    const fileName = path.basename(filePath);
    const randomThreeDigits = Math.floor(100 + Math.random() * 900);
    const destination = `dead-letter/${randomThreeDigits}_${fileName}`;

    await storage.file(filePath).setMetadata({
      metadata: {status: "dead-letter"},
    });
    await storage.file(filePath).move(destination);

    console.warn(`📦 Moved to dead-letter → ${destination}`);
  } catch (err) {
    console.error("❌ Dead-letter move failed:", err);
  }
}

// ---------- Main Function ----------
/**
 * Processes uploaded product images:
 * - Resizes to thumbnail, medium, large
 * - Uploads to bucket under `products/{productId}/`
 * - Updates product document in Mongo
 */
export const processProductImage = onObjectFinalized(
  {
    bucket: BUCKET_NAME,
    region: REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const filePath = event.data.name;
    const metadata = event.data.metadata || {};

    if (!filePath) return;

    // Skip already processed or dead-letter
    if (filePath.includes("products/") || filePath.includes("dead-letter/")) {
      console.log("Skipping already processed file:", filePath);
      return;
    }

    if (metadata?.processed === "true") return;

    const productId = metadata.productId || metadata.productid;
    const color = metadata.color;

    if (!productId) {
      console.error("Missing productId metadata for", filePath);
      return moveToDeadLetter(filePath);
    }
    if (!color) {
      console.error("Missing color metadata for", filePath);
      return moveToDeadLetter(filePath);
    }

    await connectMongo();

    const product = await Product.findOne({productId});

    if (!product) {
      console.error("Product not found for productId:", productId);
      return moveToDeadLetter(filePath);
    }

    // Validate color axis exists
    const colorAxis = Object.keys(product.variantProperties).find(
      (k) => k.toLowerCase() === "color" || k.toLowerCase() === "colour",
    );

    if (!colorAxis) {
      console.error("Color axis not found for productId:", productId);
      return moveToDeadLetter(filePath);
    }

    const allowedColors = product.variantProperties[colorAxis] || [];

    if (!allowedColors.includes(color)) {
      console.error(
        "Color not allowed for productId:",
        productId,
        "color:",
        color,
      );
      return moveToDeadLetter(filePath);
    }

    const fileName = path.basename(filePath);
    const tempInput = path.join(os.tmpdir(), fileName);

    try {
      await storage.file(filePath).download({destination: tempInput});

      const processedUrls: ProductImageSizes = {
        thumbnail: "",
        medium: "",
        large: "",
      };

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

        processedUrls[key as keyof ProductImageSizes] =
          `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
        await fs.unlink(tempOutput);
      }

      await storage.file(filePath).delete();
      await fs.unlink(tempInput);

      // Determine default image
      const hasDefault = product.images?.some(
        (img: ProductImage) => img.isDefault,
      );

      const newImage: ProductImage = {
        name: fileName,
        sizes: processedUrls,
        isDefault: !hasDefault,
        attributes: {color},
      };

      await Product.updateOne({productId}, {$push: {images: newImage}});

      console.log(`✅ Processed ${fileName}`);
    } catch (error) {
      console.error("Processing failed:", error);
      await moveToDeadLetter(filePath);
    }
  },
);
