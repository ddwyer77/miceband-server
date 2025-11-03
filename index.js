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
const { validateVideoRequest, validateCompleteVideoRequest } = require("./utils/validation");
const { axiosInstance, retryWithBackoff } = require("./utils/axiosConfig");
const { validateEnvironmentVariables } = require("./utils/envValidation"); 

const app = express();
const port = process.env.PORT || 8080;

// Configure multer for file uploads
const upload = multer({ dest: "/tmp/" });

const allowedOrigins = [
    "https://miceband.com",
    "https://micebandstaging.netlify.app",
    "https://mice-band-5d7efe3ee4f2.herokuapp.com"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
    methods: "GET, POST, PUT, DELETE, OPTIONS",
    allowedHeaders: "Origin, X-Requested-With, Content-Type, Accept, Authorization"
}));

app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({limit: "150mb", extended: true }));

// Request timeout middleware (10 minutes for video processing)
app.use((req, res, next) => {
    req.setTimeout(600000); // 10 minutes
    res.setTimeout(600000);
    next();
});

const minimaxApiKey = process.env.API_KEY_MINIMAX;

const imageToBase64 = (filePath) => {
    return fs.readFileSync(filePath, { encoding: "base64" });
};

app.get("/", (req, res) => {
    res.send("✅ Miceband server is running!");
  });

app.post("/api/get-task-id", upload.single("originalVideo"), async (req, res) => {
    const tmpDir = "/tmp";
    const timestamp = Date.now();
    const lastFramePath = path.join(tmpDir, `last_frame_${timestamp}.jpg`);
    const trimmedVideoPath = path.join(tmpDir, `trimmed_${timestamp}.mp4`);
    const inputFilePath = req.file ? path.resolve(req.file.path) : null;

    try {
        if (!req.file) return res.status(400).json({ error: "No video uploaded" });

        console.log("Init get task id...");
        
        // Validate input
        let validatedData;
        try {
            validatedData = validateVideoRequest(req.body);
        } catch (validationError) {
            return res.status(400).json({ error: validationError.message });
        }
        
        const { clipLength, prompt } = validatedData;
        
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

        console.log("Uploading trimmed video...");
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

        res.on('finish', () => {
            cleanupFiles([inputFilePath, lastFramePath]);
        });

    } catch (error) {
        console.error("❌ Error processing video:", error);
        cleanupFiles([lastFramePath, trimmedVideoPath, inputFilePath].filter(Boolean));
        return res.status(500).json({ error: "Internal server error." });
    }
});

app.post("/api/complete-video", async (req, res) => {
    const startTime = Date.now();
    const timestamp = Date.now();
    
    // Validate input
    let validatedData;
    try {
        validatedData = validateCompleteVideoRequest(req.body);
    } catch (validationError) {
        return res.status(400).json({ error: validationError.message });
    }
    
    let { aiVideoFileId, audioUrl, doubleGeneration, trimmedVideo, clipLength, generationType, email } = validatedData;
    const aiVideoPath = `/tmp/ai_generated_${timestamp}.mp4`;
    const generatedVideoWithAudioPath = `/tmp/generated_with_audio_${timestamp}.mp4`;
    const combinedVideoPath = `/tmp/combined_${timestamp}.mp4`;
    const trimmedVideoPath = `/tmp/downloadedTrimmedVideo_${timestamp}.mp4`;
    let doubleGeneratedVideoPath = null;

    try {
        console.log("Initializing complete-video route...");
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

        const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`⏱️ /api/complete-video completed in ${totalSeconds} seconds`);
        
        res.status(200).json({ success: true, videoUrl: downloadUrl });

        // if (email && email.trim() !== "") {
        //     sendVideoEmail(email, downloadUrl).catch(err => {
        //         console.error("❌ Error sending email:", err);
        //     });
        // }
    } catch (error) {
        const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error("❌ Error completing video:", error);
        console.log(`⏱️ /api/complete-video completed in ${totalSeconds} seconds`);
        try {
            await addErrorLog("complete-video", error.message, error.stack, {
                aiVideoFileId,
                doubleGeneration,
                email
            });
        } catch (logError) {
            console.error("❌ Error logging error:", logError);
        }

        const filesToCleanup = [combinedVideoPath];
        if (doubleGeneratedVideoPath) filesToCleanup.push(doubleGeneratedVideoPath);
        cleanupFiles(filesToCleanup);
        if (trimmedVideo) {
            try {
                await deleteVideoFromFirebase(trimmedVideo);
            } catch (deleteError) {
                console.error("❌ Error deleting video from Firebase:", deleteError);
            }
        }
        return res.status(500).json({ error: "Internal server error." });
    }
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/**
 * Trim a video to a specific length
 */
const trimVideo = (inputPath, outputPath, duration) => {
    return new Promise((resolve, reject) => {
        let timeout;
        const ffmpegProcess = ffmpeg(inputPath)
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
            .on("start", (commandLine) => {
                // Set timeout for FFmpeg operation (5 minutes)
                timeout = setTimeout(() => {
                    ffmpegProcess.kill("SIGKILL");
                    reject(new Error("FFmpeg trimming timeout"));
                }, 300000);
            })
            .on("end", () => {
                if (timeout) clearTimeout(timeout);
                resolve(outputPath);
            })
            .on("error", (err) => {
                if (timeout) clearTimeout(timeout);
                console.error("❌ FFmpeg trimming error:", err);
                reject(err);
            })
            .run();
    });
};

const extractLastFrame = (inputPath, outputImagePath) => {
    return new Promise((resolve, reject) => {
        let timeout;
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            const lastFrameTime = Math.max(0, duration - 0.1);

            const ffmpegProcess = ffmpeg(inputPath)
                .screenshots({ 
                    timestamps: [lastFrameTime], 
                    filename: path.basename(outputImagePath), 
                    folder: path.dirname(outputImagePath), 
                    size: "1080x1920"  // ✅ Ensure it's 9:16 like the video
                })
                .on("start", () => {
                    timeout = setTimeout(() => {
                        ffmpegProcess.kill("SIGKILL");
                        reject(new Error("FFmpeg frame extraction timeout"));
                    }, 60000); // 1 minute timeout
                })
                .on("end", () => {
                    if (timeout) clearTimeout(timeout);
                    resolve(outputImagePath);
                })
                .on("error", (err) => {
                    if (timeout) clearTimeout(timeout);
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

    const response = await retryWithBackoff(async () => {
        return await axiosInstance.post("https://api.minimaxi.chat/v1/video_generation", payload, { headers });
    });
    
    if (!response.data || !response.data.task_id) {
        throw new Error("Invalid response from Minimax API: missing task_id");
    }
    
    const taskId = response.data.task_id;
    return taskId;
};

const getAIVideoFile = async (fileId, outputPath) => {
    const headers = { Authorization: `Bearer ${minimaxApiKey}` };
    
    // Step 1: Get the video metadata (download URL) with retry
    const fileRes = await retryWithBackoff(async () => {
        return await axiosInstance.get(`https://api.minimaxi.chat/v1/files/retrieve?file_id=${fileId}`, { headers });
    });

    if (!fileRes.data || !fileRes.data.file || !fileRes.data.file.download_url) {
        console.error("❌ AI Video Not Found:", fileRes.data);
        throw new Error("AI Video not found.");
    }

    const downloadUrl = fileRes.data.file.download_url;
    
    // Step 2: Download video with timeout and retry
    const response = await retryWithBackoff(async () => {
        return await axiosInstance({ method: "GET", url: downloadUrl, responseType: "stream", timeout: 300000 });
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            writer.destroy();
            reject(new Error("Video download timeout"));
        }, 300000); // 5 minute timeout

        writer.on("finish", () => {
            clearTimeout(timeout);
            writer.close();
            resolve(outputPath);
        });
        writer.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
};

const mergeVideos = (video1, video2, outputPath) => {
    const timestamp = Date.now();
    return new Promise((resolve, reject) => {
        const tmpDir = "/tmp"; // Ensure using a valid temp directory
        let tmpFileList = null;
        let timeout;

        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        tmpFileList = path.join(tmpDir, `video_list_${timestamp}.txt`);

        try {
            fs.writeFileSync(
                tmpFileList,
                `file '${path.resolve(video1).replace(/\\/g, "/")}'\nfile '${path.resolve(video2).replace(/\\/g, "/")}'\n`
            );
        } catch (error) {
            console.error("❌ Error writing file list:", error);
            return reject(error);
        }
  
        const ffmpegProcess = ffmpeg()
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
        .on("start", () => {
            timeout = setTimeout(() => {
                ffmpegProcess.kill("SIGKILL");
                reject(new Error("FFmpeg merging timeout"));
            }, 300000); // 5 minute timeout
        })
        .on("end", () => {
            if (timeout) clearTimeout(timeout);
            try {
                if (tmpFileList && fs.existsSync(tmpFileList)) {
                    fs.unlinkSync(tmpFileList);
                }
            } catch (cleanupError) {
                console.error("❌ Error cleaning up temp file list:", cleanupError);
            }
            resolve(outputPath);
        })
        .on("error", (err) => {
            if (timeout) clearTimeout(timeout);
            try {
                if (tmpFileList && fs.existsSync(tmpFileList)) {
                    fs.unlinkSync(tmpFileList);
                }
            } catch (cleanupError) {
                console.error("❌ Error cleaning up temp file list:", cleanupError);
            }
            console.error("❌ FFmpeg merging error:", err);
            reject(err);
        })
        .run();
    });
};

async function downloadVideo(url, filePath) {
    const response = await retryWithBackoff(async () => {
        return await axiosInstance({ method: "GET", url, responseType: "stream", timeout: 300000 });
    });
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            writer.destroy();
            reject(new Error("Video download timeout"));
        }, 300000); // 5 minute timeout

        writer.on("finish", () => {
            clearTimeout(timeout);
            resolve();
        });
        writer.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

const addBackgroundMusic = (videoPath, outputPath, audioUrl, timestamp, clipLength) => {
    return new Promise(async (resolve, reject) => {
        let audioPath = null;
        let timeout;
        
        try {
            // Ensure the /tmp directory exists
            const tmpDir = "/tmp";
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            audioPath = path.join(tmpDir, `audio_${timestamp}.mp3`);
            
            // Download the audio file with retry and streaming
            const audioResponse = await retryWithBackoff(async () => {
                return await axiosInstance.get(audioUrl, { responseType: "stream", timeout: 60000 });
            });
            
            const audioWriter = fs.createWriteStream(audioPath);
            audioResponse.data.pipe(audioWriter);
            
            await new Promise((resolveAudio, rejectAudio) => {
                audioWriter.on("finish", resolveAudio);
                audioWriter.on("error", rejectAudio);
            });

            // Merge audio with video
            const ffmpegProcess = ffmpeg(videoPath)
                .input(audioPath)
                .outputOptions([
                    `-t ${clipLength}`,
                    "-preset ultrafast",       
                    "-shortest",               
                    "-c:v libx264",
                    "-c:a aac",
                    "-b:a 192k",
                    "-pix_fmt yuv420p"
                ])
                .output(outputPath)
                .on("start", () => {
                    timeout = setTimeout(() => {
                        ffmpegProcess.kill("SIGKILL");
                        reject(new Error("FFmpeg audio merge timeout"));
                    }, 300000); // 5 minute timeout
                })
                .on("end", () => {
                    if (timeout) clearTimeout(timeout);
                    // Check if file was created before resolving
                    if (fs.existsSync(outputPath)) {
                        try {
                            if (audioPath && fs.existsSync(audioPath)) {
                                fs.unlinkSync(audioPath); // Cleanup audio file
                            }
                        } catch (cleanupError) {
                            console.error("❌ Error cleaning up audio file:", cleanupError);
                        }
                        resolve(outputPath);
                    } else {
                        console.error("❌ FFmpeg finished but output file is missing:", outputPath);
                        reject(new Error("FFmpeg finished but output file is missing"));
                    }
                })
                .on("error", (err) => {
                    if (timeout) clearTimeout(timeout);
                    console.error("❌ FFmpeg audio merge failed:", err);
                    try {
                        if (audioPath && fs.existsSync(audioPath)) {
                            fs.unlinkSync(audioPath);
                        }
                    } catch (cleanupError) {
                        console.error("❌ Error cleaning up audio file:", cleanupError);
                    }
                    reject(err);
                })
                .run();
        } catch (error) {
            if (timeout) clearTimeout(timeout);
            console.error("❌ Error downloading audio or processing video:", error);
            try {
                if (audioPath && fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                }
            } catch (cleanupError) {
                console.error("❌ Error cleaning up audio file:", cleanupError);
            }
            reject(error);
        }
    });
};

const handleDoubleGeneration = async (inputVideoPath, outputVideoPath) => {
    inputVideoPath = await ensureLocalFile(inputVideoPath, `/tmp/video_${Date.now()}.mp4`);
    const reversedVideoPath = inputVideoPath.replace(/\.mp4$/, "_reversed.mp4");

    return new Promise((resolve, reject) => {
        let timeout;
        ffmpeg.ffprobe(inputVideoPath, (err, metadata) => {
            if (err) {
                return reject(new Error("Error probing video metadata: " + err.message));
            }

            const hasAudio = metadata.streams.some(stream => stream.codec_type === "audio");
            let filterGraph = "[0:v]reverse[v]";
            let outputOptions = ["-map", "[v]"];

            if (hasAudio) {
                filterGraph += ";[0:a]areverse[a]";
                outputOptions.push("-map", "[a]");
            }

            // Step 3: Reverse the AI-generated video (and audio if available)
            const ffmpegProcess = ffmpeg(inputVideoPath)
                .complexFilter(filterGraph)
                .outputOptions(outputOptions)
                .output(reversedVideoPath)
                .on("start", () => {
                    timeout = setTimeout(() => {
                        ffmpegProcess.kill("SIGKILL");
                        reject(new Error("FFmpeg reverse timeout"));
                    }, 300000); // 5 minute timeout
                })
                .on("end", async () => {
                    if (timeout) clearTimeout(timeout);
                    try {
                        await mergeVideos(inputVideoPath, reversedVideoPath, outputVideoPath);
                        cleanupFiles([inputVideoPath, reversedVideoPath]);
                        resolve(outputVideoPath);
                    } catch (mergeError) {
                        console.error("❌ Error merging videos:", mergeError);
                        reject(mergeError);
                    }
                })
                .on("error", (err) => {
                    if (timeout) clearTimeout(timeout);
                    reject(err);
                })
                .run();
        });
    })
};

const cleanupFiles = (files) => {
    files.forEach((file) => {
        if (file && fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
            } catch (error) {
                console.error(`❌ Error cleaning up file ${file}:`, error.message);
            }
        }
    });
};

const ensureLocalFile = async (videoPath, localPath) => {
    if (videoPath.startsWith("http")) {
        const response = await retryWithBackoff(async () => {
            return await axiosInstance({
                method: "GET",
                url: videoPath,
                responseType: "stream",
                timeout: 300000
            });
        });

        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                writer.destroy();
                reject(new Error("File download timeout"));
            }, 300000);

            writer.on("finish", () => {
                clearTimeout(timeout);
                resolve();
            });
            writer.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        return localPath;
    }
 
    return videoPath;
};

async function uploadAndSaveVideo(mergedVideoUrl, generationData) {
    const storagePath = `generatedVideosUnapproved/video-${Date.now()}.mp4`;
    const videoTitle = path.basename(storagePath, ".mp4");

    try {
        const localVideoPath = await ensureLocalFile(mergedVideoUrl, `/tmp/${videoTitle}.mp4`);
        const downloadUrl = await uploadGeneratedVideosForFeed(localVideoPath, storagePath);
        const newDocId = await addDocument("videos", downloadUrl, videoTitle, generationData.generationType);

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

// Validate environment variables at startup
try {
    validateEnvironmentVariables();
} catch (error) {
    console.error("❌ Environment validation failed:", error.message);
    process.exit(1);
}

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});
