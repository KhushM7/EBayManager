import { BlobServiceClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import type { PhotoStore } from "../../photos";

// Listing photos in this environment's private `photos` Blob container (infra/modules/app.bicep: no public
// access; the app's managed identity has Storage Blob Data Owner on its own storage account only).

/**
 * `ensure` makes the container (private) the first time something is written, for a container the
 * infrastructure may not have made yet (`exports`, added after go-live).
 */
export function azurePhotoStore(accountName: string, credential: TokenCredential, containerName = "photos", ensure = false): PhotoStore {
  const container = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential).getContainerClient(containerName);
  let made = !ensure;
  return {
    async put(key, bytes, contentType) {
      if (!made) {
        await container.createIfNotExists();
        made = true;
      }
      await container.getBlockBlobClient(key).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async get(key) {
      try {
        const buf = await container.getBlobClient(key).downloadToBuffer();
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (e: any) {
        if (e?.statusCode === 404) return null; // no such file, or no such container yet
        throw e;
      }
    },
    async delete(key) {
      await container.getBlobClient(key).deleteIfExists();
    },
    async deletePrefix(prefix) {
      let n = 0;
      for await (const b of container.listBlobsFlat({ prefix })) {
        await container.getBlobClient(b.name).deleteIfExists();
        n++;
      }
      return n;
    },
  };
}
