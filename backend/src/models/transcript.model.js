// backend/models/transcript.model.js
import mongoose from "mongoose";

const TranscriptSchema = new mongoose.Schema(
  {
    // ❌ removed unique: true (important fix)
    meetingCode: { type: String, required: true, index: true },

    transcriptText: { type: String, default: "" },

    fileName: { type: String, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // 🔥 optional but useful (versioning)
    version: { type: Number, default: 1 },

    // timestamps (mongoose handles automatically)
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true, // auto manages createdAt & updatedAt
  }
);

// 🔥 ensure updatedAt always refreshes
TranscriptSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// 🔥 index for fast queries
TranscriptSchema.index({ meetingCode: 1, createdAt: -1 });

export default mongoose.models.Transcript ||
  mongoose.model("Transcript", TranscriptSchema);