/**
 * 语音识别（ASR）与语音合成（TTS）前后端共用类型与预设常量。
 */

export const SPEECH_AUDIO_FORMATS = ["mp3", "wav", "opus", "aac"] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

export const MAX_SPEECH_TTS_CHARS = 4_000;
export const DEFAULT_SPEECH_TTS_VOICE = "alloy";
export const DEFAULT_SPEECH_TTS_SPEED = 1;

export type SpeechTtsProvider = "openai" | "fish";

export type SpeechKeySource = "saved" | "environment" | "none";

export type SpeechStatusView = {
  asrReady: boolean;
  ttsReady: boolean;
  defaultVoice: string;
  provider: SpeechTtsProvider;
};

export type SpeechSettingsView = {
  asr: {
    enabled: boolean;
    baseUrl: string;
    model: string;
  };
  tts: {
    enabled: boolean;
    provider: SpeechTtsProvider;
    baseUrl: string;
    model: string;
    voice: string;
    speed: number;
  };
  asrKeySource: SpeechKeySource;
  asrKeyHint: string;
  ttsKeySource: SpeechKeySource;
  ttsKeyHint: string;
  updatedAt: string | null;
};

export type SpeechSettingsInput = {
  asr: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    /** 留空或不传保留已有密钥；如需显式清空请设 clearApiKey 为 true。 */
    apiKey?: string;
    clearApiKey?: boolean;
  };
  tts: {
    enabled: boolean;
    provider: SpeechTtsProvider;
    baseUrl: string;
    model: string;
    voice: string;
    speed?: number;
    /** 留空或不传保留已有密钥；如需显式清空请设 clearApiKey 为 true。 */
    apiKey?: string;
    clearApiKey?: boolean;
  };
};

export type SpeechVoiceItem = {
  id: string;
  name: string;
  provider: SpeechTtsProvider;
  language?: string;
  gender?: string;
  previewText?: string;
};

export type SpeechTestAsrResult = {
  ok: boolean;
  message: string;
  latencyMs?: number;
};

export const SPEECH_TTS_PROVIDER_PRESETS: Readonly<
  Record<
    SpeechTtsProvider,
    {
      label: string;
      baseUrl: string;
      model: string;
      voice: string;
      note: string;
    }
  >
> = {
  openai: {
    label: "OpenAI 兼容（/audio/speech）",
    baseUrl: "https://api.openai.com/v1",
    model: "tts-1",
    voice: DEFAULT_SPEECH_TTS_VOICE,
    note: "支持 OpenAI、Kokoro-FastAPI、new-api / One API 等兼容 /audio/speech 的接口。",
  },
  fish: {
    label: "Fish Audio（/v1/tts）",
    baseUrl: "https://api.fish.audio",
    model: "s1",
    voice: "",
    note: "支持 Fish Audio 官方及兼容服务，可按关键字搜索公共音色库并在线试听。",
  },
};

export const DEFAULT_OPENAI_SPEECH_VOICES: readonly SpeechVoiceItem[] = [
  {
    id: "alloy",
    name: "Alloy（均衡中性）",
    provider: "openai",
    language: "multi",
    gender: "neutral",
    previewText: "你好，我是 Alloy，声音清晰自然，适合日常问答与信息播报。",
  },
  {
    id: "ash",
    name: "Ash（沉稳叙述）",
    provider: "openai",
    language: "multi",
    gender: "male",
    previewText: "你好，我是 Ash，语调沉稳克制，适合长文讲解与技术说明。",
  },
  {
    id: "ballad",
    name: "Ballad（温和抒情）",
    provider: "openai",
    language: "multi",
    gender: "neutral",
    previewText: "你好，我是 Ballad，语气温和流畅，适合故事讲述与陪伴对话。",
  },
  {
    id: "coral",
    name: "Coral（明朗亲切）",
    provider: "openai",
    language: "multi",
    gender: "female",
    previewText: "你好，我是 Coral，声音明朗亲切，适合助手对话与日程播报。",
  },
  {
    id: "echo",
    name: "Echo（清亮男声）",
    provider: "openai",
    language: "multi",
    gender: "male",
    previewText: "你好，我是 Echo，吐字清晰利落，适合要点总结与指令反馈。",
  },
  {
    id: "fable",
    name: "Fable（生动叙事）",
    provider: "openai",
    language: "multi",
    gender: "neutral",
    previewText: "你好，我是 Fable，节奏富有层次，适合创意文案与内容朗读。",
  },
  {
    id: "onyx",
    name: "Onyx（低沉厚实）",
    provider: "openai",
    language: "multi",
    gender: "male",
    previewText: "你好，我是 Onyx，声线低沉有力，适合正式播报与重点提醒。",
  },
  {
    id: "nova",
    name: "Nova（活力女声）",
    provider: "openai",
    language: "multi",
    gender: "female",
    previewText: "你好，我是 Nova，声线清脆有活力，适合轻快自然的语音交互。",
  },
  {
    id: "sage",
    name: "Sage（知性从容）",
    provider: "openai",
    language: "multi",
    gender: "female",
    previewText: "你好，我是 Sage，语速平稳知性，适合学习辅导与深度解读。",
  },
  {
    id: "shimmer",
    name: "Shimmer（柔和清澈）",
    provider: "openai",
    language: "multi",
    gender: "female",
    previewText: "你好，我是 Shimmer，音色柔和清澈，适合舒缓朗读与睡前播报。",
  },
  {
    id: "verse",
    name: "Verse（富表现力）",
    provider: "openai",
    language: "multi",
    gender: "male",
    previewText: "你好，我是 Verse，语气自然有表现力，适合演示汇报与对话朗读。",
  },
];
