import React, { useState } from "react";
import styles from "../styles/videoComponent.module.css";

export default function ChatInput({ onSend }) {
  const [text, setText] = useState("");

  const handleSend = () => {
    const t = text.trim();
    if (t) {
      onSend(t);
      setText("");
    }
  };

  return (
    <div
      className={styles.chatInput || ""}
      style={{ display: "flex", gap: 8, padding: 8 }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSend();
        }}
        placeholder="Type a message..."
        style={{
          flex: 1,
          padding: "8px 10px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)",
          color: "#E6EEF9",
        }}
      />

      <button
        onClick={handleSend}
        style={{
          padding: "8px 12px",
          borderRadius: 6,
          background: "rgba(0,150,255,0.12)",
          border: "none",
          color: "#E6EEF9",
        }}
      >
        Send
      </button>
    </div>
  );
}