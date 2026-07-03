import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'node:fs';

const { AWS_REGION = 'us-east-1', S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;

const credentials =
  AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
    : undefined;

const s3 = new S3Client({ region: AWS_REGION, credentials });

// Multipart upload — handles multi-GB files and retries parts on flaky links.
export async function uploadFile(file, key, contentType, onProgress) {
  const up = new Upload({
    client: s3,
    params: { Bucket: S3_BUCKET, Key: key, Body: createReadStream(file), ContentType: contentType },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
  });
  if (onProgress) up.on('httpUploadProgress', onProgress);
  await up.done();
}
