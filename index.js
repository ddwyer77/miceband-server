const express = require("express");
const multer = require("multer");
const axios = require("axios");
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require("fluent-ffmpeg");
const ffprobe = require("@ffprobe-installer/ffprobe");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
const port = 5000;

// Configure multer for file uploads
const upload = multer({ dest: "tmp/" });
app.use(cors());

const minimaxApiKey = process.env.API_KEY_MINIMAX;

const imageToBase64 = (filePath) => {
    return fs.readFileSync(filePath, { encoding: "base64" });
};

app.post("/api/trim-video", upload.single("video"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    const inputFilePath = req.file.path;
    const outputFilePath = `tmp/trimmed_${Date.now()}.mp4`;

    ffmpeg(inputFilePath)
        .setStartTime(0)
        .setDuration(5) // Trim to 5 seconds
        .output(outputFilePath)
        .on("end", () => {
            res.download(outputFilePath, "trimmed_video.mp4", (err) => {
                fs.unlinkSync(inputFilePath); // Delete original
                fs.unlinkSync(outputFilePath); // Delete trimmed file after response
            });
        })
        .on("error", (err) => {
            console.error("FFmpeg Error:", err);
            res.status(500).json({ error: "Video processing failed" });
            fs.unlinkSync(inputFilePath);
        })
        .run();
});

app.post("/api/extract-last-frame", upload.single("video"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    const inputFilePath = req.file.path;
    const outputImagePath = `uploads/last_frame_${Date.now()}.jpg`;

    // Get video duration first to extract last frame
    ffmpeg.ffprobe(inputFilePath, (err, metadata) => {
        if (err) {
            console.error("FFmpeg Error:", err);
            return res.status(500).json({ error: "Failed to get video metadata" });
        }

        const duration = metadata.format.duration; // Video duration in seconds
        const lastFrameTime = Math.max(0, duration - 0.1); // Avoid exceeding bounds

        ffmpeg(inputFilePath)
            .screenshots({
                timestamps: [lastFrameTime],
                filename: path.basename(outputImagePath),
                folder: "uploads",
                size: "1920x1080",
            })
            .on("end", () => {
                res.sendFile(path.resolve(outputImagePath), () => {
                    fs.unlinkSync(inputFilePath); // Delete original video
                    fs.unlinkSync(outputImagePath); // Delete image after sending
                });
            })
            .on("error", (err) => {
                console.error("FFmpeg Error:", err);
                res.status(500).json({ error: "Frame extraction failed" });
                fs.unlinkSync(inputFilePath);
            });
    });
});

app.post("/api/generate-video", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No image uploaded" });
        }

        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required" });
        }

        const imageBase64 = imageToBase64(req.file.path);

        // Define the payload
        const payload = {
            model: "video-01", // Image to Video model
            first_frame_image: `data:image/png;base64,${imageBase64}`,
            prompt: prompt, 
        };

        const headers = {
            authorization: `Bearer ${minimaxApiKey}`,
            "Content-Type": "application/json",
        };

        // Request AI video generation
        const response = await axios.post("https://api.minimaxi.chat/v1/video_generation", payload, { headers });

        // Delete temp image
        fs.unlinkSync(req.file.path);

        if (response.data.task_id) {
            return res.json({ task_id: response.data.task_id, message: "Video generation started." });
        } else {
            return res.status(500).json({ error: "Failed to create video generation task." });
        }
    } catch (error) {
        console.error("Error generating video:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * Query Video Generation Status
 */
app.get("/api/video-status/:taskId", async (req, res) => {
    try {
        const taskId = req.params.taskId;
        const response = await axios.get(`https://api.minimaxi.chat/v1/query/video_generation?task_id=${taskId}`, {
            headers: { authorization: `Bearer ${minimaxApiKey}` },
        });

        if (response.data.status === "Success") {
            return res.json({ status: "Success", file_id: response.data.file_id });
        } else {
            return res.json({ status: response.data.status });
        }
    } catch (error) {
        console.error("Error checking video status:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * Retrieve AI-Generated Video URL
 */
app.get("/api/get-video/:fileId", async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const response = await axios.get(`https://api.minimaxi.chat/v1/files/retrieve?file_id=${fileId}`, {
            headers: { authorization: `Bearer ${minimaxApiKey}` },
        });

        if (response.data.file && response.data.file.download_url) {
            return res.json({ download_url: response.data.file.download_url });
        } else {
            return res.status(500).json({ error: "Failed to get video URL." });
        }
    } catch (error) {
        console.error("Error retrieving video:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
