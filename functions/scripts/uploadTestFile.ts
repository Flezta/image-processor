// const { spawn } = require("child_process");
const path = require("path");
import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
dotenv.config();
const projectRoot = path.resolve(__dirname, "..");
const filePath = path.join(projectRoot, "test-images", "product-test.webp");
const bucketName = process.env.BUCKET_NAME || "flezta.firebasestorage.app";
const projectId = process.env.PROJECT_ID
const clientEmail = process.env.CLIENT_EMAIL
const privateKey = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n")
if (!projectId || !clientEmail || !privateKey) {
  throw new Error("Missing Firebase credentials in environment variables");
}
const storage = new Storage({
  projectId,
  credentials: {
    client_email: clientEmail,
    private_key: privateKey,
  },
});
const bucket = storage.bucket(bucketName);
const uploadFile = async () => {
  await bucket.upload(filePath, {
    destination: `raw/${path.basename(filePath)}`,
    metadata: {
      metadata: {
        productId: "123",
        color: "red",
      },
    },
  });
};
uploadFile()
  .then(() => console.log("✅ Test file uploaded with correct metadata!"))
  .catch((err) => console.error("❌ Upload failed:", err));
// const metadata = {
//   productId: "123",
//   color: "Red",
// };

// const args = [
//   "-h",
//   `x-goog-meta-productId=${metadata.productId}`,
//   "-h",
//   `x-goog-meta-color=${metadata.color}`,
//   "cp",
//   filePath,
//   `gs://${bucket}/raw/${path.basename(filePath)}`,
// ];
// console.log("Uploading test file with proper metadata...");
// const child = spawn("gsutil", args, { stdio: "inherit" });

// child.on("close", (code: number) => {
//   if (code === 0) {
//     console.log("✅ Test file uploaded with correct metadata!");
//   } else {
//     console.error("❌ Upload failed with code", code);
//   }
// });
