import {onObjectFinalized} from "firebase-functions/v2/storage";
import * as admin from "firebase-admin";
import mongoose from "mongoose";
import sharp from "sharp";
import path from "path";
import os from "os";
import fs from "fs/promises";
import dotenv from "dotenv";


export interface ProductImageSizes {
  thumbnail: string; // 200px
  medium: string; // 600px
  large: string; // 1200px
}

export interface ProductImage {
  name: string;
  sizes: ProductImageSizes;
  isDefault?: boolean;
  order?: number;
}


export interface ProductColor {
  value: string; // e.g., "Red"
  images: ProductImage[];
}
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;

if (!MONGO_URI || !BUCKET_NAME || !REGION) {
  throw new Error(
    "Missing required environment variables: MONGO_URI, BUCKET_NAME, and REGION"
  );
}
admin.initializeApp();

const storage = admin.storage().bucket(BUCKET_NAME);


// ---------- Mongo Connection ----------
let mongoConnected = false;
console.log("🪣 Listening to bucket:", BUCKET_NAME);
/**
 * Connects to MongoDB if not already connected.
 */
async function connectMongo() {
  if (!mongoConnected && MONGO_URI ) {
    await mongoose.connect(MONGO_URI);
    mongoConnected = true;
  }
}

// ---------- Minimal Product Model ----------
const ProductSchema = new mongoose.Schema(
  {
    productId: String,
    colors: [
      {
        value: String,
        images: [
          {
            name: String,
            sizes: {
              thumbnail: String,
              medium: String,
              large: String,
            },
            isDefault: Boolean,
          },
        ],
      },
    ],
  },
  {collection: "products"}
);

const Product = mongoose.model("Product", ProductSchema);

// ---------- Image Sizes ----------
const IMAGE_SIZES = {
  thumbnail: 200,
  medium: 800,
  large: 1500,
};

// ---------- Main Function ----------
export const processProductImage =
  onObjectFinalized(
    {bucket: BUCKET_NAME,
      region: REGION,
      memory: "1GiB", // optional but recommended for sharp
      timeoutSeconds: 300},
    async (event) => {
      console.log("📝 Event data:", event.data);
      const filePath = event.data.name;
      const metadata = event.data.metadata || {};
      if (!filePath) return;

      // Skip processed & dead-letter
      if (
        filePath.includes("/products/") ||
      filePath.includes("/dead-letter/")
      ) {
        return;
      }
      if (event.data.metadata?.status === "dead-letter") {
        console.log("⚠ Already dead-lettered. Skipping...");
        return;
      }
      if (event.data.metadata?.processed === "true") {
        console.log("⚠ Already processed. Skipping...");
        return;
      }

      const productId = metadata.productId || metadata.productid;
      const color = metadata.color || metadata.Color;

      if (!productId || !color) {
        console.warn("❌ Missing metadata");
        return moveToDeadLetter(filePath);
      }
      console.log(`📸 Processing ${filePath} for 
        productId=${productId}, color=${color}...`);
      // Check if color already has images
      await connectMongo();
      const product = await Product.findOne({
        productId,
        "colors.value": color,
      });

      if (!product) {
        console.warn("❌ Invalid productId/color");
        return moveToDeadLetter(filePath);
      }
    await Product.updateOne(
  { productId, "colors.value": color },
  {
    $set: {
      "colors.$.hasUploadedImage": true,
    },
  }
);
      const fileName = path.basename(filePath);
      const tempInput = path.join(os.tmpdir(), fileName);
      const bucket = storage;

      try {
      // ---------- Download ----------
        await bucket.file(filePath).download({
          destination: tempInput,
        });

        const processedUrls: Record<string, string> = {};

        // ---------- Resize Loop ----------
        for (const [key, width] of Object.entries(IMAGE_SIZES)) {
          const outputName = `${path.parse(fileName).name}_${width}.jpg`;
          const tempOutput = path.join(os.tmpdir(), outputName);

          await sharp(tempInput)
            .resize(width, width, {
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({quality: 85})
            .toFile(tempOutput);

          const destination = `products/${productId}/${color}/${outputName}`;

          await bucket.upload(tempOutput, {
            destination,
            metadata: {
              cacheControl: "public, max-age=31536000, immutable",
              processed: "true", // Mark as processed
            },
          });

          processedUrls[key] =
          `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;

          await fs.unlink(tempOutput);
        }

        // ---------- Delete Original ----------
        await bucket.file(filePath).delete();
        await fs.unlink(tempInput);

        // ---------- Save to Mongo ----------


        const colorData = product.colors.find(
          (c) => c.value != null && c.value === color
        );

        if (!colorData) {
          console.warn("❌ Color data not found");
          return moveToDeadLetter(filePath);
        }

        // check if there is default image for this product
        const productColors = product.colors || [];
        const hasDefaultImage = productColors.some((c) =>
          c.images.some((img) => img.isDefault === true)
        );

        const isFirstImage = !colorData.images.length && !hasDefaultImage;

        await Product.updateOne(
          {productId, "colors.value": color},
          {
            $push: {
              "colors.$.images": {
                name: fileName,
                sizes: processedUrls,
                isDefault: isFirstImage, // ⭐ AUTO DEFAULT
              },
            },
          }
        );

        console.log(
          `✅ Processed ${fileName} → ${productId} (${color})`
        );
      } catch (error) {
        console.error("❌ Processing failed:", error);
        await moveToDeadLetter(filePath);
      }
    }
  );

// ---------- Dead-Letter Handler ----------
/**
 * Moves a file to the dead-letter bucket when processing fails.
 * @param {string} filePath - The path of the file to move to
 * dead-letter storage
 */
async function moveToDeadLetter(filePath: string) {
  try {
    const bucket = storage;
    const fileName = path.basename(filePath);
    const today = new Date();
    const randomThreeDigits = Math.floor(100 + Math.random() * 900);
    const destination = `dead-letter/${randomThreeDigits}_${fileName}`;
    await bucket.file(filePath).setMetadata({
      metadata: {
        status: "dead-letter",
      },
    });
    await bucket.file(filePath).move(destination);


    console.warn(`📦 Moved to dead-letter → ${destination}`);
  } catch (err) {
    console.error("❌ Dead-letter move failed:", err);
  }
}
