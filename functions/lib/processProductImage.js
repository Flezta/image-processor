"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processProductImage = void 0;
const storage_1 = require("firebase-functions/v2/storage");
const admin = __importStar(require("firebase-admin"));
const mongoose_1 = __importDefault(require("mongoose"));
const sharp_1 = __importDefault(require("sharp"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const promises_1 = __importDefault(require("fs/promises"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const MONGO_URI = process.env.MONGO_URI;
const BUCKET_NAME = process.env.BUCKET_NAME;
const REGION = process.env.REGION;
if (!MONGO_URI || !BUCKET_NAME || !REGION) {
    throw new Error("Missing required environment variables: MONGO_URI, BUCKET_NAME, " +
        "and REGION");
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
    if (!mongoConnected && MONGO_URI) {
        await mongoose_1.default.connect(MONGO_URI);
        mongoConnected = true;
    }
}
// ---------- Minimal Product Model ----------
const ProductSchema = new mongoose_1.default.Schema({
    productId: String,
    variantProperties: Object,
    images: [
        {
            name: String,
            sizes: {
                thumbnail: String,
                medium: String,
                large: String,
            },
            isDefault: Boolean,
            attributes: {
                color: String,
            },
        },
    ],
}, { collection: "products" });
const Product = mongoose_1.default.model("Product", ProductSchema);
// ---------- Image Sizes ----------
const IMAGE_SIZES = {
    thumbnail: 200,
    medium: 800,
    large: 1500,
};
// ---------- Main Function ----------
exports.processProductImage = (0, storage_1.onObjectFinalized)({
    bucket: BUCKET_NAME,
    region: REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
}, async (event) => {
    const filePath = event.data.name;
    const metadata = event.data.metadata || {};
    console.log("metadata is", metadata);
    if (!filePath)
        return;
    // Skip already processed or dead-letter
    if (filePath.includes("products/") || filePath.includes("dead-letter/")) {
        console.log("Skipping already processed or dead-letter file:", filePath);
        return;
    }
    if (metadata?.processed === "true")
        return;
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
    const product = await Product.findOne({ productId });
    if (!product) {
        console.error("Product not found for productId:", productId);
        return moveToDeadLetter(filePath);
    }
    // Validate color still exists
    const colorAxis = Object.keys(product.variantProperties || {}).find((k) => k.toLowerCase() === "color" || k.toLowerCase() === "colour");
    if (!colorAxis) {
        console.error("Color axis not found for productId:", productId);
        return moveToDeadLetter(filePath);
    }
    const allowedColors = product.variantProperties[colorAxis] || [];
    if (!allowedColors.includes(color)) {
        console.error("Color not allowed for productId:", productId, "color:", color);
        return moveToDeadLetter(filePath);
    }
    const fileName = path_1.default.basename(filePath);
    const tempInput = path_1.default.join(os_1.default.tmpdir(), fileName);
    try {
        await storage.file(filePath).download({
            destination: tempInput,
        });
        const processedUrls = {};
        for (const [key, width] of Object.entries(IMAGE_SIZES)) {
            const outputName = `${path_1.default.parse(fileName).name}_${width}.jpg`;
            const tempOutput = path_1.default.join(os_1.default.tmpdir(), outputName);
            await (0, sharp_1.default)(tempInput)
                .resize(width, width, {
                fit: "inside",
                withoutEnlargement: true,
            })
                .jpeg({ quality: 85 })
                .toFile(tempOutput);
            const destination = `products/${productId}/${outputName}`;
            await storage.upload(tempOutput, {
                destination,
                metadata: {
                    cacheControl: "public, max-age=31536000, immutable",
                    processed: "true",
                },
            });
            processedUrls[key] =
                `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
            await promises_1.default.unlink(tempOutput);
        }
        await storage.file(filePath).delete();
        await promises_1.default.unlink(tempInput);
        // Determine default
        const hasDefault = product.images?.some((img) => img.isDefault === true);
        const newImage = {
            name: fileName,
            sizes: processedUrls,
            isDefault: !hasDefault,
            attributes: { color },
        };
        await Product.updateOne({ productId }, { $push: { images: newImage } });
        console.log(`✅ Processed ${fileName}`);
    }
    catch (error) {
        console.error("Processing failed:", error);
        await moveToDeadLetter(filePath);
    }
});
// ---------- Dead-Letter Handler ----------
/**
 * Moves a file to the dead-letter bucket when processing fails.
 * @param {string} filePath - The path of the file to move to
 * dead-letter storage
 */
async function moveToDeadLetter(filePath) {
    try {
        const bucket = storage;
        const fileName = path_1.default.basename(filePath);
        const randomThreeDigits = Math.floor(100 + Math.random() * 900);
        const destination = `dead-letter/${randomThreeDigits}_${fileName}`;
        await bucket.file(filePath).setMetadata({
            metadata: {
                status: "dead-letter",
            },
        });
        await bucket.file(filePath).move(destination);
        console.warn(`📦 Moved to dead-letter → ${destination}`);
    }
    catch (err) {
        console.error("❌ Dead-letter move failed:", err);
    }
}
//# sourceMappingURL=processProductImage.js.map