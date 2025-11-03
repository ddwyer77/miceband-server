/**
 * Input validation utilities
 */

function validateRequired(value, fieldName) {
    if (value === undefined || value === null || value === "") {
        throw new Error(`${fieldName} is required`);
    }
}

function validateNumber(value, fieldName, min = null, max = null) {
    validateRequired(value, fieldName);
    const num = Number(value);
    if (isNaN(num)) {
        throw new Error(`${fieldName} must be a valid number`);
    }
    if (min !== null && num < min) {
        throw new Error(`${fieldName} must be at least ${min}`);
    }
    if (max !== null && num > max) {
        throw new Error(`${fieldName} must be at most ${max}`);
    }
    return num;
}

function validateString(value, fieldName, minLength = null, maxLength = null) {
    validateRequired(value, fieldName);
    if (typeof value !== "string") {
        throw new Error(`${fieldName} must be a string`);
    }
    if (minLength !== null && value.length < minLength) {
        throw new Error(`${fieldName} must be at least ${minLength} characters`);
    }
    if (maxLength !== null && value.length > maxLength) {
        throw new Error(`${fieldName} must be at most ${maxLength} characters`);
    }
    return value.trim();
}

function validateVideoRequest(body) {
    const { clipLength, prompt } = body;
    
    validateNumber(clipLength, "clipLength", 0.1, 60); // Between 0.1 and 60 seconds
    validateString(prompt, "prompt", 1, 500); // Between 1 and 500 characters
    
    return {
        clipLength: Number(clipLength),
        prompt: prompt.trim()
    };
}

function validateCompleteVideoRequest(body) {
    const { aiVideoFileId, audioUrl, trimmedVideo, clipLength } = body;
    
    validateString(aiVideoFileId, "aiVideoFileId");
    validateString(audioUrl, "audioUrl");
    validateString(trimmedVideo, "trimmedVideo");
    validateNumber(clipLength, "clipLength", 0.1, 120); // Between 0.1 and 120 seconds
    
    return {
        aiVideoFileId: aiVideoFileId.trim(),
        audioUrl: audioUrl.trim(),
        trimmedVideo: trimmedVideo.trim(),
        clipLength: Number(clipLength),
        doubleGeneration: Boolean(body.doubleGeneration),
        generationType: body.generationType || "unknown",
        email: body.email ? String(body.email).trim() : null
    };
}

module.exports = {
    validateRequired,
    validateNumber,
    validateString,
    validateVideoRequest,
    validateCompleteVideoRequest
};

