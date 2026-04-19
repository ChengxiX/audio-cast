const MUSIC_MAX_BITRATE = 256000;

function parseFmtpParameters(input) {
  const parameters = new Map();

  for (const segment of input.split(";")) {
    const [rawKey, rawValue = ""] = segment.split("=");
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    parameters.set(key, rawValue.trim());
  }

  return parameters;
}

function serializeFmtpParameters(parameters) {
  return Array.from(parameters.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

export async function prepareLocalAudioTrack(track) {
  if (!track) {
    return;
  }

  if ("contentHint" in track) {
    track.contentHint = "music";
  }

  if (!track.applyConstraints) {
    return;
  }

  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
  const constraints = {};

  if (supported.autoGainControl) {
    constraints.autoGainControl = false;
  }

  if (supported.echoCancellation) {
    constraints.echoCancellation = false;
  }

  if (supported.noiseSuppression) {
    constraints.noiseSuppression = false;
  }

  if (supported.channelCount) {
    constraints.channelCount = 2;
  }

  if (supported.sampleRate) {
    constraints.sampleRate = 48000;
  }

  if (Object.keys(constraints).length === 0) {
    return;
  }

  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    console.warn("FM4382 audio constraints could not be fully applied.", error);
  }
}

export async function prepareAudioSender(sender) {
  if (!sender?.getParameters || !sender.setParameters) {
    return;
  }

  const parameters = sender.getParameters();
  if (!parameters.encodings || parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }

  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = MUSIC_MAX_BITRATE;
  }

  try {
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("FM4382 sender bitrate tuning failed.", error);
  }
}

export function tuneOpusDescription(description) {
  if (!description?.sdp) {
    return description;
  }

  const opusMatch = description.sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2$/m);
  if (!opusMatch) {
    return description;
  }

  const payloadType = opusMatch[1];
  const fmtpExpression = new RegExp(`^a=fmtp:${payloadType} (.+)$`, "m");
  const fmtpMatch = description.sdp.match(fmtpExpression);
  const parameters = fmtpMatch ? parseFmtpParameters(fmtpMatch[1]) : new Map();

  parameters.set("stereo", "1");
  parameters.set("sprop-stereo", "1");
  parameters.set("maxaveragebitrate", String(MUSIC_MAX_BITRATE));
  parameters.set("cbr", "0");
  parameters.set("useinbandfec", "1");
  parameters.set("usedtx", "0");

  const fmtpLine = `a=fmtp:${payloadType} ${serializeFmtpParameters(parameters)}`;
  const sdp = fmtpMatch
    ? description.sdp.replace(fmtpExpression, fmtpLine)
    : description.sdp.replace(opusMatch[0], `${opusMatch[0]}\r\n${fmtpLine}`);

  return {
    type: description.type,
    sdp
  };
}
