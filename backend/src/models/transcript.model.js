import mongoose from "mongoose";

const TranscriptSchema = new mongoose.Schema(
  {
    meetingCode: { type: String, required: true, uppercase: true, trim: true },
    ownerId: { type: String, default: null },
    hostSecretHash: { type: String, default: null },
    transcriptText: { type: String, default: "" },
    fileName: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
  },
  {
    timestamps: true,
  }
);

TranscriptSchema.index({ meetingCode: 1 }, { unique: true });
TranscriptSchema.index({ ownerId: 1, createdAt: -1 });
TranscriptSchema.index({ hostSecretHash: 1, createdAt: -1 });

export default mongoose.models.Transcript ||
  mongoose.model("Transcript", TranscriptSchema);