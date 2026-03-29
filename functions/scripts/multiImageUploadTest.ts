import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const color = "red";
const productId = "45109E-4868514";
const API_URL = `http://localhost:8080/products/${productId}/images/upload-urls/${color}?count=5`;

const IMAGE_FOLDER = path.join(__dirname, "multi-test-images");

// ----------------------------------------

async function getUploadUrls() {
  console.log(`Requesting upload URLs from ${API_URL}...`);
  const token = process.env.TOKEN_SECRET;
  if (!token) {
    throw new Error("Missing TOKEN_SECRET in environment variables");
  }
  const res = await axios.get(API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status !== 200) {
    throw new Error(`Failed to get upload URLs: ${res.statusText}`);
  }
  const data = res.data;
  console.log(`Received ${data.uploads.length} upload URLs`, data);
  return data.uploads;
}

async function uploadFile(uploadUrl: string, filePath: string, metadata: any) {
  const fileStream = fs.createReadStream(filePath);

  const stats = fs.statSync(filePath);

  await axios.put(uploadUrl, fileStream, {
    headers: {
      "Content-Length": stats.size,
      "Content-Type": "application/octet-stream",
      "x-goog-meta-productId": metadata.productId,
      "x-goog-meta-color": metadata.color,
    },
    maxBodyLength: Infinity,
  });

  console.log(`✅ Uploaded: ${path.basename(filePath)}`);
}

async function main() {
  try {
    console.log("Fetching upload URLs...");
    const uploads = await getUploadUrls();

    const files = fs
      .readdirSync(IMAGE_FOLDER)
      .filter((f) => !f.startsWith("."));

    if (files.length === 0) {
      throw new Error("No files found in test-images folder");
    }

    console.log(`Found ${files.length} files`);

    // const uploadPromises = uploads.map((upload: any, index: number) => {
    //   const file = files[index % files.length]; // reuse if fewer files
    //   const filePath = path.join(IMAGE_FOLDER, file);

    //   return uploadFile(upload.uploadUrl, filePath, {
    //     productId,
    //     color,
    //   });
    // });
    const uploadPromises = files.map((file: string, index: number) => {
      const upload = uploads[index % uploads.length]; // reuse if fewer URLs
      const filePath = path.join(IMAGE_FOLDER, file);

      return uploadFile(upload.uploadUrl, filePath, {
        productId,
        color,
      });
    });

    await Promise.all(uploadPromises);

    console.log("🎉 All uploads completed!");
  } catch (err: any) {
    console.error("❌ Upload failed:", err.response?.data || err.message);
  }
}

main();
