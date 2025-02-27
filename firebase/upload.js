const { getStorage, ref, uploadBytes, getDownloadURL } = require("firebase/storage");
const { initializeApp } = require("firebase/app");
const fs = require("fs");

// Firebase Config (Using Correct Environment Variables)
const firebaseConfig = {
    apiKey: process.env.API_KEY_FIREBASE,
    authDomain: process.env.AUTH_DOMAIN_FIREBASE,
    projectId: process.env.PROJECT_ID_FIREBASE,
    storageBucket: process.env.STORAGE_BUCKET_FIREBASE,
    messagingSenderId: process.env.MESSAGING_SENDER_ID_FIREBASE,
    appId: process.env.APP_ID_FIREBASE,
    measurementId: process.env.MEASUREMENT_ID_FIREBASE
};

// Initialize Firebase App & Storage
const firebaseApp = initializeApp(firebaseConfig);
const storage = getStorage(firebaseApp);

/**
 * Uploads a video to Firebase Storage and returns the download URL.
 * @param {string} localFilePath - Path to the local video file.
 * @param {string} storagePath - Firebase Storage destination path.
 * @returns {Promise<string>} - Download URL of the uploaded video.
 */
async function uploadGeneratedVideosForFeed(localFilePath, storagePath) {
    try {
        const bucketRef = ref(storage, storagePath);
        const videoBuffer = fs.readFileSync(localFilePath);

        // Upload video to Firebase Storage
        await uploadBytes(bucketRef, videoBuffer);
        console.log(`✅ Video uploaded to Firebase Storage: ${storagePath}`);

        // Get the download URL
        const downloadUrl = await getDownloadURL(bucketRef);
        console.log(`✅ Download URL: ${downloadUrl}`);

        return downloadUrl;
    } catch (error) {
        console.error("❌ Error uploading video to Firebase:", error);
        throw error;
    }
}

module.exports = { uploadGeneratedVideosForFeed };
