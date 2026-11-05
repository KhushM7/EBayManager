import { BlobServiceClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import type { PhotoStore } from "../../photos";

// Listing photos in this environment's private `photos` Blob container (infra/modules/app.bicep: no public
// access; the app's managed identity has Storage Blob Data Owner on its own storage account only).

export function azurePhotoStore(accountName: string, credential: TokenCredential): PhotoStore {
  const container = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential).getContainerClient("photos");
  return {
    async put(key, bytes, contentType) {
      await container.getBlockBlobClient(key).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async get(key) {
      try {
        const buf = await container.getBlobClient(key).downloadToBuffer();
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (e: any) {
        if (e?.statusCode === 404) return null;
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
