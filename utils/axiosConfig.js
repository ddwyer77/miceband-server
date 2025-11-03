const axios = require("axios");

/**
 * Configured axios instance with timeouts and retry logic
 */
const axiosInstance = axios.create({
    timeout: 300000, // 5 minutes for video downloads
    maxRedirects: 5,
    httpAgent: new (require("http").Agent)({
        keepAlive: true,
        maxSockets: 10
    }),
    httpsAgent: new (require("https").Agent)({
        keepAlive: true,
        maxSockets: 10
    })
});

/**
 * Retry wrapper with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            // Don't retry on 4xx errors (client errors)
            if (error.response && error.response.status >= 400 && error.response.status < 500) {
                throw error;
            }
            
            // Don't retry on last attempt
            if (attempt === maxRetries - 1) {
                throw error;
            }
            
            // Exponential backoff: delay = baseDelay * 2^attempt
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

module.exports = {
    axiosInstance,
    retryWithBackoff
};

