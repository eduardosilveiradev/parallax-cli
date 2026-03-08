/**
 * <Shimmer /> — A reusable Ink component that renders text with a
 * sweeping shimmer highlight, like an AI agent "thinking" indicator.
 */

import { useState, useEffect } from "react";
import { Text } from "ink";

// ─── Types ──────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

export interface ShimmerProps {
    /** The text to shimmer (the ◆ prefix is added automatically) */
    text?: string;
    /** Whether to animate the shimmer */
    animate?: boolean;
    /** Resting text color */
    baseColor?: RGB;
    /** Mid-glow shimmer color */
    shimmerColor?: RGB;
    /** Brightest peak of the shimmer */
    peakColor?: RGB;
    /** Character width of the glow band */
    width?: number;
    /** Sweeps per second */
    speed?: number;
    /** Target FPS for the animation */
    fps?: number;
}

// ─── Color math ─────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
    return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function colorForChar(
    index: number,
    center: number,
    shimmerWidth: number,
    base: RGB,
    shimmer: RGB,
    peak: RGB,
): RGB {
    const dist = Math.abs(index - center);
    if (dist > shimmerWidth) return base;

    const proximity = 1.0 - dist / shimmerWidth;
    const intensity = (Math.cos(Math.PI * (1 - proximity)) + 1) / 2;

    return intensity < 0.5
        ? lerpColor(base, shimmer, intensity * 2)
        : lerpColor(shimmer, peak, (intensity - 0.5) * 2);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function Shimmer({
    text = "Working...",
    animate = true,
    baseColor = [80, 80, 100],
    shimmerColor = [52, 116, 235],
    peakColor = [255, 255, 255],
    width = 13,
    speed = 1.2,
    fps = 60,
}: ShimmerProps) {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        const start = performance.now();
        const interval = setInterval(() => {
            setTick((performance.now() - start) / 1000);
        }, 1000 / fps);
        return () => clearInterval(interval);
    }, [fps]);

    const display = `◆  ${text}`;
    const totalTravel = display.length + width * 2;
    const phase = animate ? (((tick * speed) % 1.0) + 1.0) % 1.0 : 0;
    const center = phase * totalTravel - width;

    const chars = [...display].map((ch, i) => {
        const [r, g, b] = colorForChar(i, center, width, baseColor, shimmerColor, peakColor);
        return (
            <Text key={i} bold color={`rgb(${r},${g},${b})`}>
                {ch}
            </Text>
        );
    });

    return <Text>{chars}</Text>;
}
