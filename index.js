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
const { uploadGeneratedVideosForFeed } = require("./firebase/upload");
const { addDocument, addErrorLog, uploadVideoToFirebase, deleteVideoFromFirebase } = require("./firebase/firestore"); 

const app = express();
const port = process.env.PORT || 5000;

// Configure multer for file uploads
const upload = multer({ dest: "tmp/" });

const allowedOrigins = [
    "https://miceband.com",
    "https://micebandstaging.netlify.app",
    "https://mice-band-5d7efe3ee4f2.herokuapp.com"
];

app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({limit: "150mb", extended: true }));
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
}));


const minimaxApiKey = process.env.API_KEY_MINIMAX;

const imageToBase64 = (filePath) => {
    return fs.readFileSync(filePath, { encoding: "base64" });
};

app.post("/api/get-task-id", upload.single("originalVideo"), async (req, res) => {
    logMemoryUsage("Before get task id");
    const tmpDir = "/tmp";
    const timestamp = Date.now();
    const lastFramePath = path.join(tmpDir, `last_frame_${timestamp}.jpg`);
    const trimmedVideoPath = path.join(tmpDir, `trimmed_${timestamp}.mp4`);

    try {
        if (!req.file) return res.status(400).json({ error: "No video uploaded" });

        console.log("Init get task id...");
        const { clipLength, prompt } = req.body;
        const inputFilePath = path.resolve(req.file.path); 
        
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
       
        if (!fs.existsSync(inputFilePath)) {
            console.error("❌ Input file does not exist:", inputFilePath);
            return res.status(500).json({ error: "Input file is missing." });
        }
     
        console.log("Trimming video...");
        await trimVideo(inputFilePath, trimmedVideoPath, clipLength);

        console.log("Extracting last frame...");
        await extractLastFrame(trimmedVideoPath, lastFramePath);
        console.log("Last frame extracted:", lastFramePath);

        const uploadedTrimmedVideo = await uploadVideoToFirebase(trimmedVideoPath);
        cleanupFiles([trimmedVideoPath]);
      
        if (!fs.existsSync(lastFramePath)) {
            console.error("❌ File does not exist:", lastFramePath);
            return res.status(500).json({ error: "Last frame extraction failed." });
        }

        const task_id = await getAIVideoTaskId(lastFramePath, prompt);
        if (!task_id || task_id === "") {
            console.error("❌ Task ID not found:", task_id);
            return res.status(500).json({ error: "Task ID not found." });
        }
        console.log("Task ID:", task_id);
       
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="trimmed_video.mp4"`);

        res.json({ 
            status: "success", 
            task_id,
            trimmed_video: uploadedTrimmedVideo,
        });
        logMemoryUsage("After get task id");

        res.on('finish', () => {
            cleanupFiles([inputFilePath, lastFramePath]);
        });

    } catch (error) {
        console.error("❌ Error processing video:", error);
        cleanupFiles([lastFramePath, trimmedVideoPath]);
        return res.status(500).json({ error: error.message });
    }
});

app.post("/api/complete-video", async (req, res) => {
    logMemoryUsage("Before Complete");
    let { aiVideoFileId, audioUrl, doubleGeneration, trimmedVideo, clipLength, generationType, email } = req.body;

    const timestamp = Date.now();
    const aiVideoPath = `tmp/ai_generated_${timestamp}.mp4`;
    const generatedVideoWithAudioPath = `tmp/generated_with_audio_${timestamp}.mp4`;
    const combinedVideoPath = `tmp/combined_${timestamp}.mp4`;
    const trimmedVideoPath = `tmp/downloadedTrimmedVideo_${timestamp}.mp4`;
    let doubleGeneratedVideoPath = null;

    try {
        console.log("🔄 Fetching AI video...");
        await getAIVideoFile(aiVideoFileId, aiVideoPath);
        let processedVideoPath = aiVideoPath;

        // Step 1: Handle double generation if enabled
        if (doubleGeneration) {
            console.log("🔄 Performing double generation...");
            doubleGeneratedVideoPath = aiVideoPath.replace(/\.mp4$/, "_double.mp4");
            processedVideoPath = await handleDoubleGeneration(aiVideoPath, doubleGeneratedVideoPath);
            clipLength = clipLength * 2; // Double the clip length
            console.log("🎥 Double generation completed:", processedVideoPath);
        }

        // Step 2: Add background music
        console.log("Adding background audio...");
        await addBackgroundMusic(processedVideoPath, generatedVideoWithAudioPath, audioUrl, timestamp, clipLength);
        console.log("✅ Audio added:", generatedVideoWithAudioPath);
        cleanupFiles([processedVideoPath]);

        await downloadVideo(trimmedVideo, trimmedVideoPath);

        // Step 3: Merge the trimmed video with AI-generated video
        console.log("Merging videos...");
      
        await mergeVideos(trimmedVideoPath, generatedVideoWithAudioPath, combinedVideoPath);
        cleanupFiles([trimmedVideoPath, generatedVideoWithAudioPath, aiVideoPath]);
        
        const downloadUrl = await uploadAndSaveVideo(combinedVideoPath, { generationType });
        console.log("✅ Video uploaded and saved:", downloadUrl);

        const filesToCleanup = [combinedVideoPath];
        if (doubleGeneratedVideoPath) filesToCleanup.push(doubleGeneratedVideoPath);
        cleanupFiles(filesToCleanup);
        deleteVideoFromFirebase(trimmedVideo);
        logMemoryUsage("After Complete");
        
        res.status(200).json({ success: true, videoUrl: downloadUrl });

        // if (email && email.trim() !== "") {
        //     sendVideoEmail(email, downloadUrl).catch(err => {
        //         console.error("❌ Error sending email:", err);
        //     });
        // }
    } catch (error) {
        console.error("❌ Error completing video:", error);

        try {
            await addErrorLog("complete-video", error.message, error.stack, {
                aiVideoFileId,
                doubleGeneration,
                email
            });
        } catch (error) {
            console.error("❌ Error logging error:", error);
        }

        const filesToCleanup = [combinedVideoPath];
        if (doubleGeneratedVideoPath) filesToCleanup.push(doubleGeneratedVideoPath);
        cleanupFiles(filesToCleanup);
        deleteVideoFromFirebase(trimmedVideo);
        return res.status(500).json({ error: "Internal server error." });
    }
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/**
 * Trim a video to a specific length
 */
const trimVideo = (inputPath, outputPath, duration) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .outputOptions([
                "-c:v libx264", // 🔹 H.264 encoding for compatibility
                "-preset ultrafast", // 🔹 Faster processing
                "-crf 23", // 🔹 Balanced quality & file size
                "-c:a aac", // 🔹 Ensure proper audio codec
                "-b:a 192k", // 🔹 Maintain consistent audio bitrate
                "-r 25", // 🔹 Ensure stable frame rate
                "-pix_fmt yuv420p", // 🔹 Wide compatibility
                "-vf crop='min(iw,ih*9/16)':'min(iw*16/9,ih)',scale=1080:1920" // 🔹 Crop & scale to 9:16
            ])
            .output(outputPath)
            .on("end", () => {
                console.log(`✅ Trimmed video saved: ${outputPath}`);
                resolve(outputPath);
            })
            .on("error", (err) => {
                console.error("❌ FFmpeg trimming error:", err);
                reject(err);
            })
            .run();
    });
};

const extractLastFrame = (inputPath, outputImagePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            const lastFrameTime = Math.max(0, duration - 0.1);

            console.log(`🔄 Extracting last frame at: ${lastFrameTime}s`);

            ffmpeg(inputPath)
                .screenshots({ 
                    timestamps: [lastFrameTime], 
                    filename: path.basename(outputImagePath), 
                    folder: path.dirname(outputImagePath), 
                    size: "1080x1920"  // ✅ Ensure it's 9:16 like the video
                })
                .on("end", () => {
                    console.log(`✅ Frame saved as: ${outputImagePath}`);
                    resolve(outputImagePath);
                })
                .on("error", (err) => {
                    console.error("❌ FFmpeg error extracting frame:", err);
                    reject(err);
                });
        });
    });
};


const getAIVideoTaskId = async (imagePath, prompt) => {
    const imageBase64 = imageToBase64(imagePath);
    const payload = { model: "video-01", first_frame_image: `data:image/png;base64,${imageBase64}`, prompt };
    const headers = { authorization: `Bearer ${minimaxApiKey}`, "Content-Type": "application/json" };

    const response = await axios.post("https://api.minimaxi.chat/v1/video_generation", payload, { headers });
    const taskId = response.data.task_id;

    return taskId;
};

const getAIVideoFile = async (fileId, outputPath) => {
    const headers = { Authorization: `Bearer ${minimaxApiKey}` };
    console.log(`🚀 Fetching AI-generated video with File ID: ${fileId}`);

    // Step 1: Get the video metadata (download URL)
    const fileRes = await axios.get(`https://api.minimaxi.chat/v1/files/retrieve?file_id=${fileId}`, { headers });

    if (!fileRes.data.file || !fileRes.data.file.download_url) {
        console.error("❌ AI Video Not Found:", fileRes.data);
        throw new Error("AI Video not found.");
    }

    const downloadUrl = fileRes.data.file.download_url;

    // Step 2: Stream the video download
    console.log("⬇️ Streaming AI-generated video to file...");
    const response = await axios({ method: "GET", url: downloadUrl, responseType: "stream" });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on("finish", () => {
            console.log("✅ AI Video saved to:", outputPath);
            writer.close();
            resolve(outputPath);
        });
        writer.on("error", reject);
    });
};

const mergeVideos = (video1, video2, outputPath) => {
    const timestamp = Date.now();
    return new Promise((resolve, reject) => {
        const tmpDir = "/tmp"; // Ensure using a valid temp directory

        if (!fs.existsSync(tmpDir)) {
            console.log("Creating /tmp directory...");
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const tmpFileList = path.join(tmpDir, `video_list_${timestamp}.txt`);

        console.log("📄 Writing file list to:", tmpFileList);

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
        .outputOptions([
            "-c:v libx264", // 🔹 Ensure video uses H.264 codec
            "-preset ultrafast", // 🔹 Speed up encoding
            "-crf 23", // 🔹 Balance quality & file size
            "-c:a aac", // 🔹 Ensure proper audio codec
            "-b:a 192k", // 🔹 Ensure audio bitrate consistency
            "-r 25", // 🔹 Force frame rate consistency
            "-pix_fmt yuv420p", // 🔹 Ensure wide compatibility
            "-vf scale=1080:-2,setsar=1,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" // 🔹 Ensure 9:16 aspect ratio
        ])
        .output(outputPath)
        .on("end", () => {
            console.log("✅ Video merging complete:", outputPath);
            // fs.unlinkSync(tmpFileList); // Cleanup temp file
            resolve(outputPath);
        })
        .on("error", (err) => {
            console.error("❌ FFmpeg merging error:", err);
            reject(err);
        })
        .run();
    });
};

async function downloadVideo(url, filePath) {
    console.log("⬇️ Downloading video...");
    const response = await axios({ method: "GET", url, responseType: "stream" });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
    });
}

/**
 * Add background music to video
 */
const addBackgroundMusic = (videoPath, outputPath, audioUrl, timestamp, clipLength) => {
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
                .outputOptions(`-t ${clipLength}`)
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

const handleDoubleGeneration = async (inputVideoPath, outputVideoPath) => {

    inputVideoPath = await ensureLocalFile(inputVideoPath, `tmp/video_${Date.now()}.mp4`);
    const reversedVideoPath = inputVideoPath.replace(/\.mp4$/, "_reversed.mp4");

    return new Promise((resolve, reject) => {
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
                        cleanupFiles([inputVideoPath, reversedVideoPath]);
                        resolve(outputVideoPath);
                    } catch (mergeError) {
                        console.error("❌ Error merging videos:", mergeError);
                        reject(mergeError);
                    }
                })
                .on("error", reject)
                .run();
        });
    })
};

const cleanupFiles = (files) => {
    files.forEach((file) => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
};

const testImage = (lastFramePath, timestamp) => {
    const uploadDir = path.resolve("uploads"); // Define upload directory
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
    const finalLastFramePath = path.join(uploadDir, `last_frame_${timestamp}.jpg`);
    fs.copyFileSync(lastFramePath, finalLastFramePath);
    console.log("Last Frame Path:", finalLastFramePath);
    return { finalLastFramePath, };
};

const saveToTestFolder = (timestamp, videoPaths) => {
    const uploadDir = path.resolve("uploads"); // Define upload directory

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const savedFiles = {};

    videoPaths.forEach((filePath, index) => {
        const fileName = path.basename(filePath); // Extract original filename
        const finalPath = path.join(uploadDir, `${timestamp}_${fileName}`); // Rename with timestamp

        fs.copyFileSync(filePath, finalPath);
        savedFiles[`file_${index + 1}`] = finalPath; // Store file paths for reference

        console.log(`✅ Saved: ${finalPath}`);
    });

    console.log("✅ All files moved to uploads/ for preview.");
    return savedFiles;
};

const ensureLocalFile = async (videoPath, localPath) => {
    if (videoPath.startsWith("http")) {
        console.log(`⬇️ Downloading video from URL: ${videoPath}`);

        const response = await axios({
            method: "GET",
            url: videoPath,
            responseType: "arraybuffer",
        });

        fs.writeFileSync(localPath, Buffer.from(response.data));
        console.log(`✅ Video downloaded and saved to: ${localPath}`);
        return localPath;
    }

    console.log(`📄 Video is already local: ${videoPath}`);
    return videoPath;
};

async function uploadAndSaveVideo(mergedVideoUrl, generationData) {
    const storagePath = `generatedVideosUnapproved/video-${Date.now()}.mp4`;
    const videoTitle = path.basename(storagePath, ".mp4");

    try {
        // Ensure the video exists locally before uploading
        const localVideoPath = await ensureLocalFile(mergedVideoUrl, `tmp/${videoTitle}.mp4`);

        // Upload video to Firebase Storage
        const downloadUrl = await uploadGeneratedVideosForFeed(localVideoPath, storagePath);
        console.log("✅ Video uploaded to Firebase:", downloadUrl);

        // Save metadata to Firestore
        const newDocId = await addDocument("videos", downloadUrl, videoTitle, generationData.generationType);
        console.log("✅ New item added to Firestore:", newDocId);

        return downloadUrl;
    } catch (err) {
        console.error("❌ Error uploading or saving video:", err);
        throw err;
    }
}

async function sendVideoEmail(email, videoUrl) {
    try {
        const emailData = {
            service_id: process.env.EMAILJS_SERVICE_ID, 
            template_id: process.env.EMAILJS_TEMPLATE_ID, 
            user_id: process.env.EMAILJS_PUBLIC_KEY,
            accessToken: process.env.EMAILJS_PRIVATE_KEY,
            template_params: {
                send_to: email, 
                video_url: videoUrl,
                from_name: "Mice Band"
            },
        };

        const response = await axios.post("https://api.emailjs.com/api/v1.0/email/send", emailData, {
            headers: { "Content-Type": "application/json" },
        });

        if (response.status === 200) {
            console.log(`✅ Email sent successfully to ${email}`);
        } else {
            console.error("❌ Failed to send email.");
        }
    } catch (error) {
        console.error("❌ Error sending email:", error);
    }
}

const getVideoMetadata = (videoPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                return reject(err);
            }

            const videoStream = metadata.streams.find(s => s.codec_type === "video");

            if (!videoStream) {
                return reject(new Error("No video stream found"));
            }

            resolve({
                format: metadata.format.format_name,
                duration: metadata.format.duration,
                size: metadata.format.size,
                width: videoStream.width,
                height: videoStream.height,
                codec: videoStream.codec_name,
                bitrate: metadata.format.bit_rate
            });
        });
    });
};

const logMemoryUsage = (label) => {
    const used = process.memoryUsage();
    console.log(`📊 ${label} - Memory Usage (MB):`);
    console.log(`  🟢 RSS: ${(used.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  🔵 Heap Total: ${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  🔴 Heap Used: ${(used.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  🟠 External: ${(used.external / 1024 / 1024).toFixed(2)} MB`);
};

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
