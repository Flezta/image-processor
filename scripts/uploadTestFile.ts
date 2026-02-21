const { spawn } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const filePath = path.join(projectRoot, "test-images", "product-test.webp");
const bucket = process.env.BUCKET_NAME || "flezta.firebasestorage.app";

const metadata = {
  productId: "123",
  color: "Red",
};

const args = [
  "-h", `x-goog-meta-productId=${metadata.productId}`,
  "-h", `x-goog-meta-color=${metadata.color}`,
  "cp",
  filePath,
  `gs://${bucket}/raw/${path.basename(filePath)}`
];

console.log("Uploading test file with proper metadata...");
const child = spawn("gsutil", args, { stdio: "inherit" });

child.on("close", (code: number) => {
  if (code === 0) {
    console.log("✅ Test file uploaded with correct metadata!");
  } else {
    console.error("❌ Upload failed with code", code);
  }
});