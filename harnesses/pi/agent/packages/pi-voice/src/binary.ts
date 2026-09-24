import { ensureNativeBinary } from "@luan.sh/pi-libtui";
export function resolveVoiceHelperBinary(): Promise<string> {
	return ensureNativeBinary({ crate: "voice-host", binaryName: "voice-host", env: "PI_VOICE_HOST_BINARY" });
}
