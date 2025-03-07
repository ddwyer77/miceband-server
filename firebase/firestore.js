const { getFirestore, collection, addDoc } = require("firebase/firestore");
const { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } = require("firebase/storage");
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

// Initialize Firebase App & Firestore
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

/**
 * Adds a new document to Firestore with video metadata.
 * @param {string} collectionName - Firestore collection name.
 * @param {string} downloadUrl - Video URL stored in Firebase Storage.
 * @param {string} title - Video title.
 * @param {string} generationType - Type of generation (e.g., AI, user-created).
 * @returns {Promise<string>} - The ID of the newly created document.
 */
async function addDocument(collectionName, downloadUrl, title, generationType) {
    try {
        const docRef = await addDoc(collection(db, collectionName), {
            title,
            downloadUrl,
            generationType,
            createdAt: new Date()
        });

        console.log(`✅ Document added to Firestore: ${docRef.id}`);
        return docRef.id;
    } catch (error) {
        console.error("❌ Error adding document to Firestore:", error);
        throw error;
    }
}

/**
 * Logs an error to Firestore in the "errors" collection.
 * @param {string} functionName - The function where the error occurred.
 * @param {string} message - Error message.
 * @param {string} stackTrace - Stack trace for debugging.
 * @param {object} additionalData - Any extra details (optional).
 */
async function addErrorLog(functionName, message, stackTrace, additionalData = {}) {
    try {
        const errorRef = await addDoc(collection(db, "errors"), {
            functionName,
            message,
            stackTrace,
            additionalData,
            timestamp: new Date()
        });

        console.log(`🚨 Error logged to Firestore: ${errorRef.id}`);
    } catch (firestoreError) {
        console.error("🔥 Firestore Logging Failed:", firestoreError);
    }
}

/**
 * Uploads a video file to Firebase Storage.
 * @param {string} localFilePath - Path to the local video file.
 * @returns {Promise<string>} - The download URL of the uploaded video.
 */
async function uploadVideoToFirebase(localFilePath) {
    try {
        const storage = getStorage(firebaseApp);
        const timestamp = Date.now();
        const fileName = `video-${timestamp}.mp4`;
        const storagePath = `videos/${fileName}`;
        const storageRef = ref(storage, storagePath);

        // Read file data
        const fileBuffer = fs.readFileSync(localFilePath);

        // Upload file to Firebase Storage
        await uploadBytes(storageRef, fileBuffer);
        console.log(`✅ Video uploaded to Firebase Storage: ${storagePath}`);

        // Get the download URL
        const downloadUrl = await getDownloadURL(storageRef);
        console.log(`📥 Download URL: ${downloadUrl}`);

        return downloadUrl;
    } catch (error) {
        console.error("❌ Error uploading video to Firebase:", error);
        throw error;
    }
}

/**
 * Deletes a video from Firebase Storage.
 * @param {string} videoUrl - The Firebase Storage URL of the video to delete.
 * @returns {Promise<void>}
 */
async function deleteVideoFromFirebase(videoUrl) {
    try {
        if (!videoUrl.includes("firebasestorage.googleapis.com")) {
            throw new Error("Invalid Firebase Storage URL");
        }

        // Extract the storage path from the URL
        const decodedUrl = decodeURIComponent(videoUrl);
        const match = decodedUrl.match(/o\/(.+?)\?/);

        if (!match || !match[1]) {
            throw new Error("Unable to extract storage path from URL");
        }

        const storagePath = match[1]; // Extracted path, e.g., "generatedVideosUnapproved/video-12345.mp4"

        const storage = getStorage();
        const storageRef = ref(storage, storagePath);

        // Delete the video from Firebase Storage
        await deleteObject(storageRef);
        console.log(`✅ Video deleted from Firebase Storage: ${storagePath}`);
    } catch (error) {
        console.error("❌ Error deleting video from Firebase:", error);
        throw error;
    }
}


module.exports = { addDocument, addErrorLog, uploadVideoToFirebase, deleteVideoFromFirebase };
