import { readFile, writeFile } from "node:fs/promises";

const sourcePath = new URL("../data/photos.json", import.meta.url);
const targetPath = new URL("../public/photos.json", import.meta.url);
const photos = JSON.parse(await readFile(sourcePath, "utf8"));

if (!Array.isArray(photos)) {
  throw new Error("data/photos.json must contain an array.");
}

const manifest = {
  photos: photos.map((photo) => ({
    ...photo,
    src: stripLeadingSlash(photo.src),
    displaySrc: stripLeadingSlash(photo.displaySrc),
    mobileSrc: stripLeadingSlash(photo.mobileSrc)
  })),
  generatedAt: new Date().toISOString()
};

await writeFile(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.photos.length} public photos to public/photos.json`);

function stripLeadingSlash(value) {
  return typeof value === "string" ? value.replace(/^\/+/, "") : value;
}
