/**
 * Validate required environment variables at startup
 */
function validateEnvironmentVariables() {
    const requiredVars = [
        "API_KEY_MINIMAX",
        "API_KEY_FIREBASE",
        "AUTH_DOMAIN_FIREBASE",
        "PROJECT_ID_FIREBASE",
        "STORAGE_BUCKET_FIREBASE",
        "MESSAGING_SENDER_ID_FIREBASE",
        "APP_ID_FIREBASE"
    ];

    const missing = requiredVars.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        console.error("❌ Missing required environment variables:");
        missing.forEach(varName => console.error(`   - ${varName}`));
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    console.log("✅ All required environment variables are set");
}

module.exports = {
    validateEnvironmentVariables
};

