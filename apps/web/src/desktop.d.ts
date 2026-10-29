interface Window {
  duobookDesktop?: { saveModel(config: {
    provider: string; base_url: string; model: string; timeout: number; api_key?: string;
  }): Promise<void>;
    saveReadingPosition(bookId: string, position: import("./types").ReadingPositionInput): Promise<import("./types").ReadingPositionPayload>;
    onFlushReadingPosition(callback: () => Promise<void>): () => void;
    openCompactReader(path: string): Promise<void>;
    getCompactShortcut(): Promise<{ enabled: boolean; accelerator: string; registered: boolean; error: string }>;
    saveCompactShortcut(value: { enabled: boolean; accelerator: string }): Promise<{ enabled: boolean; accelerator: string; registered: boolean; error: string }>;
    toggleCompactReader(): Promise<void>;
    setCompactShortcutRecording(active: boolean): Promise<void>;
    onCompactVisibility(callback: (hidden: boolean) => void): () => void;
    closeCompactReader(path: string): Promise<void>;
    setCompactWindow(options: { width: number; height: number; alwaysOnTop: boolean; returnPath: string }): Promise<void>;
    getCompactPreferences(): Promise<import("./compactReading").CompactPreferences | null>;
    saveCompactPreferences(preferences: import("./compactReading").CompactPreferences): Promise<void>;
    onCompactReturn(callback: (path: string) => void): () => void;
    getAppIcon(): Promise<1 | 2 | 3 | 4>;
    setAppIcon(id: 1 | 2 | 3 | 4): Promise<void>;
    getSpeechSettings(): Promise<import("./speech").SpeechSettings | null>;
    saveSpeechSettings(settings: import("./speech").SpeechSettings): Promise<void>;
    saveSpeechConfiguration(configuration: { base_url: string; api_key?: string; timeout: number }): Promise<void>;
  };
}
