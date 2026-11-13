// Deterministic mapping between subtitle seconds and video frames.
// A time t maps to the nearest frame: Math.round(t * fps).
// A cue occupies frames [startFrame, endFrame): endFrame is exclusive.
export function frameForTime(seconds, fps) {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid time mapping: seconds=${seconds}, fps=${fps}`);
  }
  return Math.round(seconds * fps);
}

export function timeForFrame(frame, fps) {
  return frame / fps;
}

export function cueFrameRange(cue, fps) {
  const startFrame = frameForTime(cue.start, fps);
  const endFrame = frameForTime(cue.end, fps);
  return { startFrame, endFrame, frameCount: Math.max(0, endFrame - startFrame) };
}

export function isCueActiveAtFrame(cue, fps, frame) {
  const { startFrame, endFrame } = cueFrameRange(cue, fps);
  return frame >= startFrame && frame < endFrame;
}

export function activeCuesAtFrame(cues, fps, frame) {
  return cues.filter((cue) => isCueActiveAtFrame(cue, fps, frame));
}

export function buildActiveSegments(cues, fps, totalFrames) {
  const segments = [];
  let current = null;
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const active = activeCuesAtFrame(cues, fps, frame).map((cue) => cue.id);
    const key = active.join('|');
    if (!current || current.key !== key) {
      if (current) current.endFrame = frame;
      current = { key, cueIds: active, startFrame: frame, endFrame: totalFrames };
      segments.push(current);
    }
  }
  if (current) current.endFrame = Math.min(current.endFrame, totalFrames);
  return segments;
}

export function validateCueTiming(cues) {
  const issues = [];
  for (const cue of cues) {
    if (!(cue.end > cue.start)) {
      issues.push({ cueId: cue.id, type: 'non-positive-range', message: '结束时间必须晚于开始时间' });
    }
  }
  return issues;
}
