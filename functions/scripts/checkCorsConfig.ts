import * as dotenv from "dotenv";
import { exec } from "child_process";

// Load environment variables from .env file
dotenv.config();

// Extract environment variables from process.env
const BUCKET_NAME = process.env.BUCKET_NAME;

if (!BUCKET_NAME) {
  console.error("Error: BUCKET_NAME is not defined in .env file");
  process.exit(1);
}
console.log(
  `Checking CORS configuration for Firebase Storage bucket: gs://${BUCKET_NAME}`,
);

const command = `gsutil cors get gs://${BUCKET_NAME}`;

// Execute the command
exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`Error checking CORS configuration: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`stderr: ${stderr}`);
    return;
  }
  console.log(`CORS configuration for bucket gs://${BUCKET_NAME}: ${stdout}`);
});