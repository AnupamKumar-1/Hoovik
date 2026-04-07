import React, { useState, useRef } from "react";
import styles from "../styles/videoComponent.module.css";


export default function ChatInput({ onSend }) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  const canSend = text.trim().length > 0;

  const handleSend = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    // Restore focus after React re-render
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.chatInputWrap}>
      <input
        ref={inputRef}
        className={styles.chatInputField}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…"
        aria-label="Chat message"
        autoComplete="off"
        spellCheck="true"
        maxLength={1000}
      />

      <button
        className={styles.chatSendButton}
        onClick={handleSend}
        disabled={!canSend}
        aria-label="Send message"
        title="Send (Enter)"
        type="button"
      >
        {/* Send arrow */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
        Send
      </button>
    </div>
  );
}