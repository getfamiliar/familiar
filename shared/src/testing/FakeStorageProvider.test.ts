import { FakeStorageProvider } from "./FakeStorageProvider.js";
import { runStorageProviderContract } from "./StorageProviderContract.js";

for (const flavor of ["onedrive", "gdrive", "dropbox"] as const) {
    runStorageProviderContract(`fake (${flavor})`, () => new FakeStorageProvider({ flavor }), {
        account: "a@x",
        selector: null,
        largeFileBytes: 64 * 1024,
    });
}
