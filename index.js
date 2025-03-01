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
const { addDocument } = require("./firebase/firestore"); 

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
    const tmpDir = "/tmp";
    const timestamp = Date.now();
    const lastFramePath = path.join(tmpDir, `last_frame_${timestamp}.jpg`);
    const trimmedVideoPath = path.join(tmpDir, `trimmed_${timestamp}.mp4`);

    try {
        if (!req.file) return res.status(400).json({ error: "No video uploaded" });

        const { clipLength, prompt } = req.body;
        console.log("Processing video...");
        const inputFilePath = path.resolve(req.file.path); 
        
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
       
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

        // testImage(lastFramePath, timestamp);
      
        if (!fs.existsSync(lastFramePath)) {
            console.error("❌ File does not exist:", lastFramePath);
            return res.status(500).json({ error: "Last frame extraction failed." });
        }

        const task_id = await getAIVideoTaskId(lastFramePath, prompt);
        console.log("Task ID:", task_id);

        const videoBuffer = fs.readFileSync(trimmedVideoPath);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="trimmed_video.mp4"`);

        res.json({ 
            status: "success", 
            task_id,
            trimmed_video: videoBuffer.toString("base64"),
        });

        res.on('finish', () => {
            cleanupFiles([inputFilePath, lastFramePath, trimmedVideoPath]);
        });

    } catch (error) {
        console.error("❌ Error processing video:", error);
        cleanupFiles([lastFramePath, trimmedVideoPath]);
        return res.status(500).json({ error: "Internal server error." });
    }
});

app.post("/api/complete-video", async (req, res) => {
    const timestamp = Date.now();
    const aiVideoPath = `tmp/ai_generated_${timestamp}.mp4`;
    const trimmedVideoPath = `tmp/trimmed_${timestamp}.mp4`;
    const generatedVideoWithAudioPath = `tmp/generated_with_audio_${timestamp}.mp4`;
    const combinedVideoPath = `tmp/combined_${timestamp}.mp4`;

    try {
        let { aiVideoFileId, audioUrl, doubleGeneration, trimmedVideo, clipLength, generationType, email } = req.body;

        console.log("🔄 Fetching AI video...");
        await getAIVideoFile(aiVideoFileId, aiVideoPath);
        let processedVideoPath = aiVideoPath;
        
        saveBase64VideoToFile(trimmedVideo, trimmedVideoPath);

        // Step 1: Handle double generation if enabled
        if (doubleGeneration) {
            console.log("🔄 Performing double generation...");
            const doubleGeneratedVideoPath = aiVideoPath.replace(/\.mp4$/, "_double.mp4");
            processedVideoPath = await handleDoubleGeneration(aiVideoPath, doubleGeneratedVideoPath);
            clipLength = clipLength * 2; // Double the clip length
            console.log("🎥 Double generation completed:", processedVideoPath);
        }

        // Step 2: Add background music
        console.log("Adding background audio...");
        await addBackgroundMusic(processedVideoPath, generatedVideoWithAudioPath, audioUrl, timestamp, clipLength);
        console.log("✅ Audio added:", generatedVideoWithAudioPath);

        // Step 3: Merge the trimmed video with AI-generated video
        console.log("Merging videos...");
        
        await mergeVideos(trimmedVideoPath, generatedVideoWithAudioPath, combinedVideoPath);
        console.log("✅ Videos merged:", combinedVideoPath);

        console.log("✅ Video processing complete!", combinedVideoPath);

        //TODO: Comment out
        // saveToTestFolder(timestamp, [trimmedVideoPath, aiVideoPath, generatedVideoWithAudioPath, combinedVideoPath])

        const downloadUrl = await uploadAndSaveVideo(combinedVideoPath, { generationType });
        console.log("✅ Video uploaded and saved:", downloadUrl);

        // if (email && email.trim() !== "") {
        //     console.log(`📧 Sending email to ${email}...`);
        //     await sendVideoEmail(email, downloadUrl);
        // }

        cleanupFiles([aiVideoPath, generatedVideoWithAudioPath, combinedVideoPath, trimmedVideoPath]);
        return res.status(200).json({ success: true, videoUrl: downloadUrl });
    } catch (error) {
        console.error("❌ Error completing video:", error);
        cleanupFiles([aiVideoPath, generatedVideoWithAudioPath, combinedVideoPath, trimmedVideoPath]);
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
                "-preset veryfast", // 🔹 Faster processing
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

    // Step 2: Download the actual video file
    console.log("⬇️ Downloading AI-generated video...");
    const videoData = await axios.get(downloadUrl, { responseType: "arraybuffer" });

    // Step 3: Save video to output path
    fs.writeFileSync(outputPath, videoData.data);
    console.log("✅ AI Video saved to:", outputPath);

    return outputPath;
};

/**
 * Merge two videos
 */
const mergeVideos = (video1, video2, outputPath) => {
    // saveToTestFolder( Date.now(), [video1, video2]);
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
        .outputOptions([
            "-c:v libx264", // 🔹 Ensure video uses H.264 codec
            "-preset veryfast", // 🔹 Speed up encoding
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
            fs.unlinkSync(tmpFileList); // Cleanup temp file
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


/**
 * Handle Double Generation: Reverse AI video and merge with original
 */
const handleDoubleGeneration = async (inputVideoPath, outputVideoPath) => {

    inputVideoPath = await ensureLocalFile(inputVideoPath, `tmp/video_${Date.now()}.mp4`);

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
                        console.error("❌ Error merging videos:", mergeError);
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


const saveBase64VideoToFile = (base64String, filePath) => {
    try {
        console.log("🔄 Decoding Base64 video...");
        const videoBuffer = Buffer.from(base64String, "base64");
        fs.writeFileSync(filePath, videoBuffer);
        console.log("✅ Trimmed video saved:", filePath);
        return filePath;
    } catch (error) {
        console.error("❌ Error saving Base64 video:", error);
        throw new Error("Failed to save Base64 video.");
    }
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
            service_id: process.env.EMAILJS_SERVICE_ID, // EmailJS Service ID
            template_id: process.env.EMAILJS_TEMPLATE_ID, // EmailJS Template ID
            user_id: process.env.EMAILJS_PUBLIC_KEY, // EmailJS Public Key
            template_params: {
                recipient_email: email, // Email of the recipient
                video_url: videoUrl,
                from_name: "Mice Band" // Video URL to be included in the email
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

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
