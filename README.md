# AT Photoroom

A single-page personal photo album with floating 3D photos, all-caps Helvetica styling, and an owner-only upload panel.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

The local default owner password is `at-photoroom`. For anything public, set your own password and session secret first:

```bash
export ALBUM_ADMIN_PASSWORD="your-password"
export SESSION_SECRET="a-long-random-secret"
npm start
```

Uploaded images are stored in `public/photos`, and their captions live in `data/photos.json`.

## Publish To GitHub Pages

GitHub Pages is static hosting, so it cannot run the local upload server or keep a private database. The public site uses:

- `public/photos/*` for image files
- `public/photos.json` as the public photo manifest
- `.github/workflows/deploy-pages.yml` to deploy the `public/` folder

After uploading photos locally, run:

```bash
npm run sync:static
```

Then commit and push the changed files. In the GitHub repository, set **Settings -> Pages -> Build and deployment -> Source** to **GitHub Actions**. The workflow will publish the album from the `public/` folder.
