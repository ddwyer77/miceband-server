const { getFirestore, collection, addDoc } = require("firebase/firestore");
const { initializeApp } = require("firebase/app");

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

module.exports = { addDocument, addErrorLog };
