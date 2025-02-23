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

app.post("/api/process-video", upload.single("originalVideo"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No video uploaded" });

        // Extract user-provided parameters
        const { prompt, clipLength, doubleGeneration, audioUrl, generationType } = req.body;
        const timestamp = Date.now();
        console.log("Processing video for:", generationType);

        const inputFilePath = path.resolve(req.file.path); // Convert to absolute path
        const tmpDir = "/tmp"; // Ensure temp directory exists
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
   
        const trimmedVideoPath = path.join(tmpDir, `trimmed_${timestamp}.mp4`);
        const lastFramePath = path.join(tmpDir, `last_frame_${timestamp}.jpg`);
        const aiVideoPath = path.join(tmpDir, `ai_generated_${timestamp}.mp4`);
        const generatedVideoWithAudioPath = path.join(tmpDir, `generated_with_audio_${timestamp}.mp4`);
        const combinedVideoPath = path.join(tmpDir, `combined_${timestamp}.mp4`);

        if (!fs.existsSync(inputFilePath)) {
            console.error("❌ Input file does not exist:", inputFilePath);
            return res.status(500).json({ error: "Input file is missing." });
        }

        // Step 1: Trim video to user-defined length
        console.log("Trimming video...");
        await trimVideo(inputFilePath, trimmedVideoPath, clipLength);

        // Step 2: Extract last frame
        console.log("Extracting last frame...");
        await extractLastFrame(trimmedVideoPath, lastFramePath);
        console.log("Last frame extracted:", lastFramePath);

        // Step 3: Generate AI video from last frame
        console.log("Generating AI video...");
        let generatedVideoPath = await generateAIVideo(lastFramePath, prompt, aiVideoPath);
        console.log("AI video generated:", generatedVideoPath);

        // Step 4: Handle double generation if enabled
        if (doubleGeneration) {
            console.log("🔄 Performing double generation...");
            const doubleGeneratedVideoPath = aiVideoPath.replace(/\.mp4$/, "_double.mp4");
            generatedVideoPath = await handleDoubleGeneration(generatedVideoPath, doubleGeneratedVideoPath);
            console.log("🎥 Double generation completed:", generatedVideoPath);
        }

        // Step 4: Add background music
        console.log("Adding background audio...");
        await addBackgroundMusic(generatedVideoPath, generatedVideoWithAudioPath, audioUrl, timestamp);
        console.log("Audio added:", generatedVideoWithAudioPath);

        // Step 5: Merge the trimmed video with AI-generated video
        console.log("Merging videos...");
        await mergeVideos(trimmedVideoPath, generatedVideoWithAudioPath, combinedVideoPath);
        console.log("Videos merged:", combinedVideoPath);

        console.log("✅ Video processing complete! ", combinedVideoPath);

        //TODO: Remove before merging
        // saveToTestFolder(timestamp, trimmedVideoPath, lastFramePath, aiVideoPath, combinedVideoPath);

        // Return final video with metadata
        res.download(path.resolve(combinedVideoPath), "generated_video.mp4", (err) => {
            if (err) {
                console.error("Error sending final video:", err);
                return res.status(500).json({ error: "Failed to send video." });
            }
            // Cleanup temp files after sending
            cleanupFiles([inputFilePath, trimmedVideoPath, lastFramePath, aiVideoPath, combinedVideoPath]);
        });
    } catch (error) {
        console.error("❌ Error processing video:", error);
        cleanupFiles([inputFilePath, trimmedVideoPath, lastFramePath, aiVideoPath, combinedVideoPath]);
        return res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * Test
 */
app.get("/api/video", (req, res) => {
    const { filename } = req.query;
    if (!filename) {
        return res.status(400).send("Filename is required");
    }

    // Ensure correct path handling for all OS
    const videoPath = path.join(__dirname, "tmp", filename);

    console.log("Checking for file:", videoPath);

    if (!fs.existsSync(videoPath)) {
        return res.status(404).send("Video not found");
    }

    res.sendFile(videoPath);
});

// TODO: REMOVE
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/**
 * Trim a video to a specific length
 */
const trimVideo = (inputPath, outputPath, duration) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .on("end", () => resolve(outputPath))
            .on("error", reject)
            .run();
    });
};

/**
 * Extract the last frame of a video
 */
const extractLastFrame = (inputPath, outputImagePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            const lastFrameTime = Math.max(0, duration - 0.1);
            ffmpeg(inputPath)
                .screenshots({ timestamps: [lastFrameTime], filename: path.basename(outputImagePath), folder: "/tmp", size: "1920x1080" })
                .on("end", () => resolve(outputImagePath))
                .on("error", reject);
        });
    });
};

/**
 * Generate AI video using MiniMax API
 */
const generateAIVideo = async (imagePath, prompt, outputPath) => {
    const imageBase64 = imageToBase64(imagePath);
    const payload = { model: "I2V-01", first_frame_image: `data:image/png;base64,${imageBase64}`, prompt };
    const headers = { authorization: `Bearer ${minimaxApiKey}`, "Content-Type": "application/json" };

    const response = await axios.post("https://api.minimaxi.chat/v1/video_generation", payload, { headers });
    const taskId = response.data.task_id;
    
    // Poll for completion
    let fileId;
    while (!fileId) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        const statusRes = await axios.get(`https://api.minimaxi.chat/v1/query/video_generation?task_id=${taskId}`, { headers });
        if (statusRes.data.status === "Success") fileId = statusRes.data.file_id;
    }

    // Retrieve AI video
    const fileRes = await axios.get(`https://api.minimaxi.chat/v1/files/retrieve?file_id=${fileId}`, { headers });
    fs.writeFileSync(outputPath, (await axios.get(fileRes.data.file.download_url, { responseType: "arraybuffer" })).data);
    
    return outputPath;
};

/**
 * Merge two videos
 */
const mergeVideos = (video1, video2, outputPath) => {
    return new Promise((resolve, reject) => {
        const tmpDir = "/tmp"; // Ensure using a valid temp directory

        if (!fs.existsSync(tmpDir)) {
            console.log("Creating /tmp directory...");
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        // Define the file list path
        const tmpFileList = path.join(__dirname, "video_list.txt");

        console.log("📄 Writing file list to:", tmpFileList);

        // Create a temporary file list for FFmpeg
        try {
            fs.writeFileSync(
                tmpFileList,
                `file '${path.resolve(video1).replace(/\\/g, "/")}'\nfile '${path.resolve(video2).replace(/\\/g, "/")}'\n`
            );
        } catch (error) {
            console.error("❌ Error writing file list:", error);
            return reject(error);
        }

        console.log("✅ File list created successfully.");

        // Run FFmpeg to merge videos
        ffmpeg()
            .input(tmpFileList)
            .inputOptions(["-f concat", "-safe 0"]) // Use concat mode
            .outputOptions(["-c copy"]) // Copy streams without re-encoding
            .output(outputPath)
            .on("end", () => {
                console.log("✅ Video merging complete:", outputPath);
                fs.unlinkSync(tmpFileList); // Cleanup temporary file
                resolve(outputPath);
            })
            .on("error", (err) => {
                console.error("❌ FFmpeg merging error:", err);
                reject(err);
            })
            .run();
    });
};

/**
 * Add background music to video
 */
const addBackgroundMusic = (videoPath, outputPath, audioUrl, timestamp) => {
    return new Promise(async (resolve, reject) => {
        try {
            // Ensure the /tmp directory exists
            const tmpDir = path.join(__dirname, "tmp");
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            // Download the audio file
            const audioResponse = await axios.get(audioUrl, { responseType: "arraybuffer" });
            const audioPath = path.join(tmpDir, `audio_${timestamp}.mp3`);
            fs.writeFileSync(audioPath, Buffer.from(audioResponse.data));

            // Merge audio with video
            ffmpeg(videoPath)
                .input(audioPath)
                .outputOptions("-shortest")
                .output(outputPath)
                .on("end", () => {
                    // Check if file was created before resolving
                    if (fs.existsSync(outputPath)) {
                        console.log("✅ Audio successfully added:", outputPath);
                        fs.unlinkSync(audioPath); // Cleanup audio file
                        resolve(outputPath);
                    } else {
                        console.error("❌ FFmpeg finished but output file is missing:", outputPath);
                        reject(new Error("FFmpeg finished but output file is missing"));
                    }
                })
                .on("error", (err) => {
                    console.error("❌ FFmpeg audio merge failed:", err);
                    reject(err);
                })
                .run();
        } catch (error) {
            console.error("❌ Error downloading audio or processing video:", error);
            reject(error);
        }
    });
};

/**
 * Handle Double Generation: Reverse AI video and merge with original
 */
const handleDoubleGeneration = (inputVideoPath, outputVideoPath) => {
    return new Promise((resolve, reject) => {
        const reversedVideoPath = inputVideoPath.replace(/\.mp4$/, "_reversed.mp4");

        console.log("🔄 Checking if AI video has audio:", inputVideoPath);

        // Step 1: Check if the input video has an audio stream
        ffmpeg.ffprobe(inputVideoPath, (err, metadata) => {
            if (err) {
                return reject("❌ Error probing video metadata: " + err);
            }

            const hasAudio = metadata.streams.some(stream => stream.codec_type === "audio");

            console.log(`🎵 Audio detected: ${hasAudio}`);

            // Step 2: Build the filtergraph dynamically
            let filterGraph = "[0:v]reverse[v]";
            let outputOptions = ["-map", "[v]"];

            if (hasAudio) {
                filterGraph += ";[0:a]areverse[a]";
                outputOptions.push("-map", "[a]");
            }

            console.log("Applying filter:", filterGraph);

            // Step 3: Reverse the AI-generated video (and audio if available)
            ffmpeg(inputVideoPath)
                .complexFilter(filterGraph)
                .outputOptions(outputOptions)
                .output(reversedVideoPath)
                .on("end", async () => {
                    console.log("✅ Reversed video created:", reversedVideoPath);

                    // Step 4: Merge original and reversed video
                    try {
                        await mergeVideos(inputVideoPath, reversedVideoPath, outputVideoPath);
                        console.log("✅ Double generation complete:", outputVideoPath);
                        resolve(outputVideoPath);
                    } catch (mergeError) {
                        reject(mergeError);
                    }
                })
                .on("error", reject)
                .run();
        });
    });
};

/**
 * Cleanup temporary files
 */
const cleanupFiles = (files) => {
    files.forEach((file) => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
};

const saveToTestFolder = (timestamp, trimmedVideoPath, lastFramePath, aiVideoPath, combinedVideoPath) => {
    const uploadDir = path.resolve("uploads"); // Define upload directory

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const finalTrimmedPath = path.join(uploadDir, `trimmed_${timestamp}.mp4`);
    const finalLastFramePath = path.join(uploadDir, `last_frame_${timestamp}.jpg`);
    const finalAiVideoPath = path.join(uploadDir, `ai_generated_${timestamp}.mp4`);
    const finalCombinedPath = path.join(uploadDir, `combined_${timestamp}.mp4`);

    fs.copyFileSync(trimmedVideoPath, finalTrimmedPath);
    fs.copyFileSync(lastFramePath, finalLastFramePath);
    fs.copyFileSync(aiVideoPath, finalAiVideoPath);
    fs.copyFileSync(combinedVideoPath, finalCombinedPath);

    console.log("✅ Files moved to uploads/ for preview.");
    console.log("Trimmed Video Path:", finalTrimmedPath);
    console.log("Last Frame Path:", finalLastFramePath);
    console.log("AI Video Path:", finalAiVideoPath);
    console.log("Combined Video Path:", finalCombinedPath);

    return { finalTrimmedPath, finalLastFramePath, finalAiVideoPath, finalCombinedPath };
};


app.listen(port, () => console.log(`Server running on port ${port}`));
