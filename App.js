import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, AppState, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as Location from "expo-location";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";

import { fingerprintFile, shortHash, ZERO_HASH } from "./src/hash.js";
import { eventHash } from "./src/chain.js";
import {
  getDb, insertSealedItem, queueEvent, listItems, pendingCounts,
  getSetting, setSetting, clearLocal,
} from "./src/db.js";
import { sync, checkServer } from "./src/api.js";
import { FadeIn, PendingBadge, ProgressBar, SkeletonList, StatusDot } from "./src/ui.js";
import {
  isAudioFile, formatDuration, startRecording, stopRecording,
  cancelRecording, inspectAudioDuration, getRecorderStatus,
} from "./src/audio.js";

const DEFAULTS = {
  serverUrl: "https://custody-api-mvgr.onrender.com",
  officerBadge: "NPF-22841",
  caseRef: "CID-2026-0041",
};

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default function App() {
  return (
    <SafeAreaProvider>
      <FieldApp />
    </SafeAreaProvider>
  );
}

function FieldApp() {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState(DEFAULTS);
  const [items, setItems] = useState([]);
  const [pending, setPending] = useState({ items: 0, events: 0, total: 0 });
  const [online, setOnline] = useState(null);
  const [busy, setBusy] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [description, setDescription] = useState("");
  const [recordingState, setRecordingState] = useState(null);
  const recordingRef = useRef(null);
  const syncTimer = useRef(null);

  const refresh = useCallback(async () => {
    setItems(await listItems());
    setPending(await pendingCounts());
  }, []);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        cancelRecording(recordingRef.current).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (!recordingRef.current) return;
      if (state === "background" || state === "inactive") {
        setRecordingState((prev) => (prev ? { ...prev, wasBackgrounded: true } : null));
      } else if (state === "active") {
        const status = getRecorderStatus(recordingRef.current);
        if (status) {
          setRecordingState((prev) =>
            prev ? {
              ...prev,
              durationMs: status.durationMs,
              isRecording: status.isRecording,
            } : null
          );
        }
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    (async () => {
      await getDb();
      const saved = await getSetting("settings", DEFAULTS);
      // The server address is part of the build, not a stored preference, so an
      // address saved by an earlier version cannot strand the device.
      setSettings({ ...DEFAULTS, ...saved, serverUrl: DEFAULTS.serverUrl });
      await refresh();
      setLoaded(true);
    })();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const ok = await checkServer(settings.serverUrl);
        if (!cancelled) setOnline(ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    probe();
    const t = setInterval(probe, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [settings.serverUrl]);

  useEffect(() => {
    if (online && pending.total > 0 && !syncing) {
      clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => runSync(true), 1200);
    }
    return () => clearTimeout(syncTimer.current);
  }, [online, pending.total]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings(next) {
    setSettings(next);
    await setSetting("settings", next);
  }

  async function sealAsset({ name, uri, mimeType, durationMs = null }) {
    try {
      const collectedAt = new Date().toISOString();
      setBusy({ label: `Fingerprinting ${name}`, chunks: 0, totalChunks: 1 });

      const fp = await fingerprintFile(uri, {
        onProgress: ({ chunks, totalChunks }) =>
          setBusy({ label: `Fingerprinting ${name}`, chunks, totalChunks }),
      });

      let coords = null;
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.granted) {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      } catch {}

      let resolvedDuration = durationMs;
      const isAudio = isAudioFile(mimeType, name);
      if (resolvedDuration == null && isAudio) {
        resolvedDuration = await inspectAudioDuration(uri);
      }

      const localId = uid();
      const prefix = isAudio ? "EX-AUDIO-" : "EX-FIELD-";
      const reference = `${prefix}${Date.now().toString().slice(-6)}`;

      await insertSealedItem({
        localId,
        reference,
        caseRef: settings.caseRef,
        description: description.trim() || (isAudio ? `Audio statement (${formatDuration(resolvedDuration)})` : name),
        fileName: name,
        fileUri: uri,
        fileSizeBytes: fp.fileSizeBytes,
        mimeType: mimeType || (isAudio ? "audio/m4a" : null),
        durationMs: resolvedDuration,
        rootHash: fp.rootHash,
        chunkSizeBytes: fp.chunkSizeBytes,
        chunkHashes: fp.chunkHashes,
        collectedAt,
        collectedBy: settings.officerBadge,
        lat: coords?.lat,
        lng: coords?.lng,
      });

      const localHash = await eventHash({
        prevHash: ZERO_HASH,
        itemId: localId,
        actorId: settings.officerBadge,
        action: "collected",
        deviceTime: collectedAt,
        fileHash: fp.rootHash,
      });

      const noteParts = [
        isAudio ? `Audio evidence (${formatDuration(resolvedDuration)}) collected in the field` : "Collected in the field",
        coords ? "position recorded" : null,
      ].filter(Boolean).join(", ");

      await queueEvent({
        localId: uid(),
        itemLocal: localId,
        itemRef: reference,
        action: "collected",
        actorBadge: settings.officerBadge,
        note: noteParts,
        deviceTime: collectedAt,
        localHash,
      });

      setDescription("");
      setBusy(null);
      setNotice({
        kind: "sealed",
        text: `${reference} sealed. ${fp.chunkHashes.length} chunk${fp.chunkHashes.length === 1 ? "" : "s"}, fingerprint ${shortHash(fp.rootHash)}`,
      });
      await refresh();
    } catch (err) {
      setBusy(null);
      Alert.alert("Could not seal the item", String(err.message ?? err));
    }
  }

  async function collectFile() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];

      let durationMs = null;
      if (isAudioFile(asset.mimeType, asset.name)) {
        durationMs = await inspectAudioDuration(asset.uri);
      }

      await sealAsset({
        name: asset.name,
        uri: asset.uri,
        mimeType: asset.mimeType,
        durationMs,
      });
    } catch (err) {
      Alert.alert("Could not select file", String(err.message ?? err));
    }
  }

  async function handleStartRecording() {
    try {
      setRecordingState({ durationMs: 0, isRecording: true, wasBackgrounded: false });
      const rec = await startRecording({
        onProgress: ({ durationMs, isRecording }) => {
          setRecordingState((prev) =>
            prev ? {
              ...prev,
              durationMs,
              isRecording,
            } : null
          );
        },
      });
      recordingRef.current = rec;
    } catch (err) {
      setRecordingState(null);
      Alert.alert("Recording Error", err.message ?? String(err));
    }
  }

  async function handleStopAndSealRecording() {
    if (!recordingRef.current) return;
    const rec = recordingRef.current;
    recordingRef.current = null;
    const result = await stopRecording(rec);
    setRecordingState(null);

    if (!result?.uri) {
      Alert.alert("Recording Error", "No audio was captured.");
      return;
    }

    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const fileName = `AUDIO-${timestamp}.m4a`;

    await sealAsset({
      name: fileName,
      uri: result.uri,
      mimeType: "audio/m4a",
      durationMs: result.durationMillis,
    });
  }

  async function handleCancelRecording() {
    if (!recordingRef.current) return;
    const rec = recordingRef.current;
    recordingRef.current = null;
    await cancelRecording(rec);
    setRecordingState(null);
  }

  async function runSync(silent = false) {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await sync(settings.serverUrl);
      if (!result.skipped) {
        setNotice({
          kind: "synced",
          text: `Synced. ${result.sealed} item${result.sealed === 1 ? "" : "s"} confirmed by the server${result.rejected ? `, ${result.rejected} rejected` : ""}.`,
        });
      }
    } catch (err) {
      if (!silent) Alert.alert("Sync failed", String(err.message ?? err));
      setNotice({ kind: "failed", text: `Sync failed: ${String(err.message ?? err).slice(0, 90)}` });
    } finally {
      setSyncing(false);
      await refresh();
    }
  }

  const statusOf = (item) =>
    item.sync_state === "synced" ? { label: "Synced", style: s.badgeOk }
    : item.sync_state === "failed" ? { label: "Sync failed", style: s.badgeBad }
    : { label: "Sealed, not synced", style: s.badgeWarn };

  return (
    <View style={[s.safe, { paddingTop: insets.top }]}>
      <StatusBar style="light" />

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Custody</Text>
          <Text style={s.subtitle}>Field collection</Text>
        </View>
        {pending.total > 0 && (
          <PendingBadge style={s.pendingBadge}>
            <Text style={s.pendingText}>{pending.total} pending</Text>
          </PendingBadge>
        )}
        <StatusDot online={online} style={s.dot} onlineStyle={s.dotOn} offlineStyle={s.dotOff} />
        <Pressable onPress={() => setShowSettings((v) => !v)} hitSlop={10}>
          <Text style={s.gear}>{showSettings ? "Done" : "Setup"}</Text>
        </Pressable>
      </View>

      {showSettings && (
        <View style={s.settings}>
          <Field label="Officer badge" value={settings.officerBadge}
            onChange={(v) => saveSettings({ ...settings, officerBadge: v })} />
          <Field label="Case reference" value={settings.caseRef}
            onChange={(v) => saveSettings({ ...settings, caseRef: v })} />
          <Pressable
            style={s.dangerButton}
            onPress={() =>
              Alert.alert("Clear this device?", "Removes the local record only. The server keeps everything already synced.", [
                { text: "Cancel", style: "cancel" },
                { text: "Clear", style: "destructive", onPress: async () => { await clearLocal(); await refresh(); } },
              ])
            }>
            <Text style={s.dangerText}>Clear local record (demo reset)</Text>
          </Pressable>
        </View>
      )}

      <ScrollView contentContainerStyle={s.body}>
        <View style={s.card}>
          <Text style={s.cardLabel}>Description (optional)</Text>
          <TextInput
            style={s.input}
            value={description}
            onChangeText={setDescription}
            placeholder="What is this item?"
            placeholderTextColor="#8a8a80"
          />

          {recordingState ? (
            <View style={s.recordingBox}>
              <View style={s.recordingTop}>
                <View style={s.recIndicator}>
                  <View style={[s.recPulseDot, !recordingState.isRecording && s.recPulseDotPaused]} />
                  <Text style={[s.recRecordingLabel, !recordingState.isRecording && s.recRecordingLabelPaused]}>
                    {recordingState.isRecording ? "LIVE AUDIO RECORDING" : "RECORDING PAUSED"}
                  </Text>
                </View>
                <Text style={s.recDurationText}>{formatDuration(recordingState.durationMs)}</Text>
              </View>
              {recordingState.wasBackgrounded && (
                <View style={[s.recNoticeBanner, { flexDirection: "row", alignItems: "flex-start", gap: 6 }]}>
                  <Ionicons name="warning" size={16} color="#fde047" style={{ marginTop: 2 }} />
                  <Text style={[s.recNoticeText, { flex: 1 }]}>
                    Audio capture was paused while outside the app (Expo Go limitation). Timer tracks actual recorded audio.
                  </Text>
                </View>
              )}
              <View style={s.recActionsRow}>
                <Pressable
                  style={[s.recStopBtn, { flexDirection: "row", justifyContent: "center", gap: 6 }]}
                  onPress={handleStopAndSealRecording}
                  disabled={!!busy}
                >
                  <Ionicons name="stop" size={14} color="#ffffff" />
                  <Text style={s.recStopBtnText}>Stop & Seal</Text>
                </Pressable>
                <Pressable
                  style={s.recCancelBtn}
                  onPress={handleCancelRecording}
                  disabled={!!busy}
                >
                  <Text style={s.recCancelBtnText}>Discard</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={s.actionBtnRow}>
              <Pressable
                style={[s.primary, s.halfBtn, busy && s.primaryDisabled, { flexDirection: "row", justifyContent: "center", gap: 6 }]}
                onPress={collectFile}
                disabled={!!busy}
              >
                <Ionicons name="folder-open" size={16} color="#ffffff" />
                <Text style={s.primaryText}>Choose file</Text>
              </Pressable>
              <Pressable
                style={[s.audioRecordBtn, s.halfBtn, busy && s.primaryDisabled, { flexDirection: "row", justifyContent: "center", gap: 6 }]}
                onPress={handleStartRecording}
                disabled={!!busy}
              >
                <Ionicons name="mic" size={16} color="#86efac" />
                <Text style={s.audioRecordBtnText}>Record audio</Text>
              </Pressable>
            </View>
          )}

          <Text style={s.hint}>
            The fingerprint is taken here, on this device, before the file goes anywhere.
            This works with no network.
          </Text>
        </View>

        {busy && (
          <FadeIn style={s.card}>
            <Text style={s.cardLabel}>{busy.label}</Text>
            <ProgressBar
              progress={busy.chunks / Math.max(busy.totalChunks, 1)}
              indeterminate={busy.chunks === 0}
            />
            <Text style={s.hint}>
              {busy.chunks === 0
                ? "Reading the file."
                : `Chunk ${busy.chunks} of ${busy.totalChunks}. Each chunk is 4MB and is hashed on ` +
                  "its own, so memory use does not grow with the size of the file."}
            </Text>
          </FadeIn>
        )}

        {notice && (
          <FadeIn key={notice.text} style={[s.notice, notice.kind === "failed" ? s.noticeBad : s.noticeOk]}>
            <Text style={notice.kind === "failed" ? s.noticeBadText : s.noticeOkText}>{notice.text}</Text>
          </FadeIn>
        )}

        <View style={s.rowBetween}>
          <Text style={s.sectionTitle}>Sealed items</Text>
          <Pressable onPress={() => runSync(false)} disabled={syncing || pending.total === 0}>
            <Text style={[s.syncLink, (syncing || pending.total === 0) && s.syncLinkOff]}>
              {syncing ? "Syncing…" : "Sync now"}
            </Text>
          </Pressable>
        </View>

        {!loaded && <SkeletonList count={2} />}

        {loaded && items.length === 0 && (
          <FadeIn>
            <Text style={s.empty}>
              Nothing collected on this device yet. Tap Choose file or Record audio to seal an item.
            </Text>
          </FadeIn>
        )}

        {items.map((item, index) => {
          const status = statusOf(item);
          const chunks = JSON.parse(item.chunk_hashes).length;
          const isAudio = isAudioFile(item.mime_type, item.file_name);
          return (
            <FadeIn key={item.local_id} delay={Math.min(index * 55, 330)} style={s.item}>
              <View style={s.rowBetween}>
                <Text style={s.itemRef}>{item.reference}</Text>
                <View style={[s.badge, status.style]}>
                  <Text style={s.badgeText}>{status.label}</Text>
                </View>
              </View>
              <Text style={s.itemDesc}>{item.description}</Text>
              <Text style={s.itemMeta}>
                {item.file_name} · {(item.file_size_bytes / 1024 / 1024).toFixed(2)} MB{item.duration_ms ? ` · ${formatDuration(item.duration_ms)} audio` : ""} · {chunks} chunk{chunks === 1 ? "" : "s"}
              </Text>
              <Text style={s.fingerprint}>{shortHash(item.root_hash)}</Text>
              {isAudio && (
                <AudioPlayerRow uri={item.file_uri} durationMs={item.duration_ms} />
              )}
              <Text style={s.itemMeta}>
                Device clock {new Date(item.collected_at).toLocaleString()}
              </Text>
              {item.sealed_at && (
                <Text style={s.itemMeta}>
                  Server confirmed {new Date(item.sealed_at).toLocaleString()}
                </Text>
              )}
              {item.sync_error && <Text style={s.itemError}>{item.sync_error}</Text>}
            </FadeIn>
          );
        })}

        <Text style={s.footer}>
          All data used in this demonstration is synthetic.
        </Text>
      </ScrollView>
    </View>
  );
}

function AudioPlayerRow({ uri, durationMs }) {
  const player = useAudioPlayer(uri, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);

  const durationSec = status.duration || (durationMs ? durationMs / 1000 : 0);
  const currentSec = status.currentTime || 0;
  const progress = durationSec > 0 ? Math.min(currentSec / durationSec, 1) : 0;

  const togglePlay = () => {
    try {
      if (status.playing) {
        player.pause();
      } else {
        if (currentSec >= durationSec && durationSec > 0) {
          player.seekTo(0);
        }
        player.play();
      }
    } catch (err) {
      Alert.alert("Playback failed", "Unable to play audio: " + (err.message ?? err));
    }
  };

  return (
    <View style={s.audioPlayer}>
      <Pressable onPress={togglePlay} style={s.audioPlayBtn} hitSlop={8}>
        <Ionicons name={status.playing ? "pause" : "play"} size={14} color="#86efac" style={status.playing ? {} : { marginLeft: 2 }} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <View style={s.audioTrack}>
          <View style={[s.audioProgress, { width: `${(progress * 100).toFixed(1)}%` }]} />
        </View>
        <View style={s.audioTimeRow}>
          <Text style={s.audioTimeText}>{formatDuration(Math.round(currentSec * 1000))}</Text>
          <Text style={s.audioTimeText}>{formatDuration(Math.round(durationSec * 1000))}</Text>
        </View>
      </View>
    </View>
  );
}

function Field({ label, value, onChange, hint }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.cardLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor="#8a8a80"
      />
      {hint && <Text style={s.hint}>{hint}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#12120f" },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 18, paddingTop: 20, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: "#2a2a24",
  },
  title: { color: "#f6f6f2", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  subtitle: { color: "#8a8a80", fontSize: 12 },
  pendingBadge: { backgroundColor: "#7a5c00", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11 },
  pendingText: { color: "#ffd77a", fontSize: 12, fontWeight: "700" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: "#4ade80" },
  dotOff: { backgroundColor: "#7a7a70" },
  gear: { color: "#9ab6ff", fontSize: 14, fontWeight: "600" },

  settings: { padding: 18, backgroundColor: "#1a1a16", borderBottomWidth: 1, borderBottomColor: "#2a2a24" },
  body: { padding: 18, paddingBottom: 60 },

  card: { backgroundColor: "#1c1c17", borderRadius: 10, padding: 16, marginBottom: 16 },
  cardLabel: { color: "#c9c9bf", fontSize: 13, fontWeight: "600", marginBottom: 6 },
  input: {
    backgroundColor: "#12120f", color: "#f6f6f2", borderRadius: 7,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
    borderWidth: 1, borderColor: "#32322a",
  },
  hint: { color: "#8a8a80", fontSize: 12, marginTop: 8, lineHeight: 17 },

  primary: { backgroundColor: "#2f6f3f", borderRadius: 8, paddingVertical: 15, alignItems: "center", marginTop: 12 },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  actionBtnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  halfBtn: { flex: 1, marginTop: 0 },
  audioRecordBtn: {
    backgroundColor: "#172b1d",
    borderRadius: 8,
    paddingVertical: 15,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2f6f3f",
  },
  audioRecordBtnText: { color: "#86efac", fontSize: 16, fontWeight: "700" },

  recordingBox: {
    backgroundColor: "#201212",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#5a2020",
    padding: 14,
    marginTop: 12,
  },
  recordingTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  recIndicator: { flexDirection: "row", alignItems: "center", gap: 8 },
  recPulseDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#ef4444" },
  recPulseDotPaused: { backgroundColor: "#f59e0b" },
  recRecordingLabel: { color: "#fca5a5", fontSize: 11, fontWeight: "700", letterSpacing: 0.8 },
  recRecordingLabelPaused: { color: "#fcd34d" },
  recDurationText: { color: "#f6f6f2", fontSize: 20, fontWeight: "700", fontFamily: "Menlo" },
  recNoticeBanner: {
    backgroundColor: "#2e2410",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#5c4815",
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  recNoticeText: {
    color: "#fde047",
    fontSize: 12,
    lineHeight: 16,
  },
  recActionsRow: { flexDirection: "row", gap: 10 },
  recStopBtn: {
    flex: 2,
    backgroundColor: "#2f6f3f",
    borderRadius: 7,
    paddingVertical: 12,
    alignItems: "center",
  },
  recStopBtnText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  recCancelBtn: {
    flex: 1,
    backgroundColor: "#2a2a24",
    borderRadius: 7,
    paddingVertical: 12,
    alignItems: "center",
  },
  recCancelBtnText: { color: "#c9c9bf", fontSize: 14, fontWeight: "600" },

  audioPlayer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#151512",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a2a24",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  audioPlayBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#244d2e",
    alignItems: "center",
    justifyContent: "center",
  },
  audioPlayIcon: { color: "#86efac", fontSize: 14, fontWeight: "700" },
  audioTrack: {
    height: 4,
    backgroundColor: "#2e2e28",
    borderRadius: 2,
    overflow: "hidden",
  },
  audioProgress: {
    height: 4,
    backgroundColor: "#86efac",
    borderRadius: 2,
  },
  audioTimeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  audioTimeText: { color: "#8a8a80", fontSize: 11, fontFamily: "Menlo" },

  notice: { borderRadius: 8, padding: 12, marginBottom: 16 },
  noticeOk: { backgroundColor: "#12331d" },
  noticeBad: { backgroundColor: "#3a1614" },
  noticeOkText: { color: "#86efac", fontSize: 13.5, lineHeight: 19 },
  noticeBadText: { color: "#fca5a5", fontSize: 13.5, lineHeight: 19 },

  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#f6f6f2", fontSize: 17, fontWeight: "700", marginBottom: 10 },
  syncLink: { color: "#9ab6ff", fontSize: 14, fontWeight: "600" },
  syncLinkOff: { color: "#5a5a52" },
  empty: { color: "#8a8a80", fontSize: 13.5, lineHeight: 20 },

  item: { backgroundColor: "#1c1c17", borderRadius: 10, padding: 14, marginBottom: 12 },
  itemRef: { color: "#f6f6f2", fontSize: 15, fontWeight: "700" },
  itemDesc: { color: "#d8d8ce", fontSize: 14, marginTop: 4 },
  itemMeta: { color: "#8a8a80", fontSize: 12, marginTop: 3 },
  itemError: { color: "#fca5a5", fontSize: 12, marginTop: 6 },
  fingerprint: {
    color: "#86efac", fontSize: 14, marginTop: 8, letterSpacing: 1.2,
    fontFamily: "Menlo", fontWeight: "600",
  },

  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10 },
  badgeText: { fontSize: 11, fontWeight: "700", color: "#12120f" },
  badgeOk: { backgroundColor: "#86efac" },
  badgeWarn: { backgroundColor: "#ffd77a" },
  badgeBad: { backgroundColor: "#fca5a5" },

  dangerButton: { paddingVertical: 10 },
  dangerText: { color: "#fca5a5", fontSize: 13.5, fontWeight: "600" },
  footer: { color: "#5a5a52", fontSize: 11.5, textAlign: "center", marginTop: 24 },
});
