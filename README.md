# wachin.tv

A simple video streaming service backed by a **private S3 bucket**. A small
Express backend lists the videos in your bucket and hands the browser
short-lived **presigned URLs**, so the bucket never needs to be public and
video seeking still works (S3 honors HTTP range requests).

```
browser ──/api/videos──▶ Express ──ListObjectsV2──▶ S3
browser ──/api/stream──▶ Express ──presigned GET──▶ (URL)
browser ────────────── plays video directly from ──▶ S3
```

## Prerequisites

- Node.js 18+ (uses the built-in fetch and `node --watch`)
- An AWS account with an S3 bucket containing video files (`.mp4`, `.webm`,
  `.mov`, `.m4v`, `.mkv`, `.ogg`)
- AWS credentials that can `s3:ListBucket` and `s3:GetObject` on that bucket

## Setup

```bash
npm install
cp .env.example .env   # then edit .env with your bucket + region
npm start
```

Open http://localhost:3000.

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Region the bucket is in, e.g. `us-east-1` |
| `S3_BUCKET` | Name of the private bucket holding your videos |
| `S3_PREFIX` | Optional "folder" prefix, e.g. `videos/` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Leave blank to use the default AWS credential chain |
| `URL_TTL_SECONDS` | How long a stream URL stays valid (default 3600) |
| `PORT` | Web server port (default 3000) |

## Adding videos

Upload files to the bucket (or under `S3_PREFIX`) with the AWS Console or CLI:

```bash
aws s3 cp "My Movie.mp4" s3://your-bucket/videos/
```

They show up in the library on the next page load. Titles are derived from the
file name.

## Notes on the private bucket

Keep **Block Public Access ON**. This app never makes objects public — it signs
a temporary GET URL per play request. If your bucket enforces SSE-KMS, the
signing credentials also need `kms:Decrypt`.

For production you'd typically put this behind auth and/or CloudFront signed
URLs, but this is intentionally the simplest version.
