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
        await mongoose_1.default.connect(process.env.MONGO_URI);
        mongoConnected = true;
    }
}
// ---------- Models ----------
const Product = mongoose_1.default.model("Product", new mongoose_1.default.Schema({
    productId: String,
    variantProperties: { type: Object, default: {} },
    images: [],
}, { collection: "products" }));
// ---------- Helpers ----------
async function moveToDeadLetter(filePath) {
    try {
        const fileName = path_1.default.basename(filePath);
        const random = Math.floor(100 + Math.random() * 900);
        const destination = `dead-letter/${random}_${fileName}`;
        await storage.file(filePath).setMetadata({
            metadata: { status: "dead-letter" },
        });
        await storage.file(filePath).move(destination);
        console.warn("Moved to dead-letter:", destination);
    }
    catch (err) {
        console.error("Dead-letter failed:", err);
    }
}
function extractMetadata(event) {
    const filePath = event.data.name;
    const metadata = event.data.metadata || {};
    return {
        filePath,
        productId: metadata.productId || metadata.productid,
        color: metadata.color,
        metadata,
    };
}
function shouldSkip(filePath, metadata) {
    if (!filePath)
        return true;
    if (filePath.includes("products/") || filePath.includes("dead-letter/")) {
        return true;
    }
    if (metadata?.processed === "true")
        return true;
    return false;
}
async function validateProduct(productId, color) {
    const product = await Product.findOne({ productId });
    if (!product)
        throw new Error("PRODUCT_NOT_FOUND");
    const colorAxis = Object.keys(product.variantProperties).find((k) => k.toLowerCase() === "color" || k.toLowerCase() === "colour");
    if (!colorAxis)
        throw new Error("COLOR_AXIS_NOT_FOUND");
    const allowedColors = product.variantProperties[colorAxis] || [];
    if (!allowedColors.includes(color)) {
        throw new Error("INVALID_COLOR");
    }
    return product;
}
async function downloadFile(filePath, tempPath) {
    await storage.file(filePath).download({ destination: tempPath });
}
async function validateImage(tempPath) {
    // Size check
    const stats = await promises_1.default.stat(tempPath);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > MAX_FILE_SIZE_MB) {
        throw new Error("FILE_TOO_LARGE");
    }
    // Metadata check
    let metadata;
    try {
        metadata = await (0, sharp_1.default)(tempPath).metadata();
    }
    catch {
        throw new Error("INVALID_IMAGE");
    }
    if (!metadata.format || !ALLOWED_FORMATS.includes(metadata.format)) {
        throw new Error("UNSUPPORTED_FORMAT");
    }
    if ((metadata.width || 0) < MIN_WIDTH ||
        (metadata.height || 0) < MIN_HEIGHT) {
        throw new Error("IMAGE_TOO_SMALL");
    }
    return metadata;
}
async function processAndUploadImages(tempInput, fileName, productId) {
    const urls = {};
    for (const [key, width] of Object.entries(IMAGE_SIZES)) {
        const outputName = `${path_1.default.parse(fileName).name}_${width}.jpg`;
        const tempOutput = path_1.default.join(os_1.default.tmpdir(), outputName);
        await (0, sharp_1.default)(tempInput)
            .resize(width, width, { fit: "inside", withoutEnlargement: true })
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
        urls[key] =
            `https://storage.googleapis.com/${process.env.BUCKET_NAME}/${destination}`;
        await promises_1.default.unlink(tempOutput);
    }
    return urls;
}
async function updateProductImages(product, productId, fileName, urls, color) {
    const hasDefault = product.images?.some((img) => img.isDefault);
    const newImage = {
        name: fileName,
        sizes: urls,
        isDefault: !hasDefault,
        attributes: { color },
    };
    await Product.updateOne({ productId }, { $push: { images: newImage } });
}
// ---------- Main Function ----------
exports.processProductImage = (0, storage_1.onObjectFinalized)({
    bucket: process.env.BUCKET_NAME,
    region: process.env.REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
}, async (event) => {
    const { filePath, productId, color, metadata } = extractMetadata(event);
    if (shouldSkip(filePath, metadata))
        return;
    if (!productId || !color) {
        console.error("Missing metadata:", filePath);
        return moveToDeadLetter(filePath);
    }
    const fileName = path_1.default.basename(filePath);
    const tempInput = path_1.default.join(os_1.default.tmpdir(), fileName);
    try {
        await connectMongo();
        const product = await validateProduct(productId, color);
        await downloadFile(filePath, tempInput);
        await validateImage(tempInput);
        const urls = await processAndUploadImages(tempInput, fileName, productId);
        await storage.file(filePath).delete();
        await promises_1.default.unlink(tempInput);
        await updateProductImages(product, productId, fileName, urls, color);
        console.log("Processed:", fileName);
    }
    catch (err) {
        console.error("Processing failed:", err.message);
        await moveToDeadLetter(filePath);
    }
});
//# sourceMappingURL=processProductImage.js.map