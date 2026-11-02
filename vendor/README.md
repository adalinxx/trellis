# Vendored

- `lattice-sdk.js`: `@0xLattice/lattice-sdk` bundled as ESM (its `@noble`
  dependencies included), the same bundle as Stoa's `app/vendor/lattice-sdk.js`.
  It runs in Node and in the browser:

  ```sh
  printf 'export * from "<lattice-sdk>/packages/sdk/dist/index.js";\n' > entry.mjs
  npx esbuild@0.24.0 entry.mjs --bundle --format=esm --platform=browser --minify --outfile=lattice-sdk.js
  ```

- `storage-file.mjs`: 0xLattice/lattice-storage `client/file.mjs` at
  `fc24f13`, the file layout git blobs are stored in.
