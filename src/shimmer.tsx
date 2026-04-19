import React, { useState, useEffect } from "react";
import { Text } from "ink";

interface ShimmerProps {
    text: string;
    animate?: boolean;
    width?: number;
}

export function Shimmer({ text, animate = true, width = 13 }: ShimmerProps) {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!animate) return;
        const start = performance.now();
        const interval = setInterval(
            () => setTick((performance.now() - start) / 1000),
            33,
        ); // ~30 FPS
        return () => clearInterval(interval);
    }, [animate]);

    const display = text.startsWith('\u25C6') || text.startsWith('\uD83D') ? text : `\u25C6  ${text}`;
    const speed = 1.2;
    const phase = animate ? (((tick * speed) % 1.0) + 1.0) % 1.0 : 0;
    const totalSpan = display.length + width * 2;
    const center = phase * totalSpan - width;

    // Base → Glow → Peak color ramp (blue/lavender theme)
    const BASE: [number, number, number] = [80, 80, 100];
    const GLOW: [number, number, number] = [52, 116, 235];
    const PEAK: [number, number, number] = [255, 255, 255];

    function lerp3(
        a: [number, number, number],
        b: [number, number, number],
        t: number,
    ): string {
        const r = Math.round(a[0] + (b[0] - a[0]) * t);
        const g = Math.round(a[1] + (b[1] - a[1]) * t);
        const bl = Math.round(a[2] + (b[2] - a[2]) * t);
        return `rgb(${r},${g},${bl})`;
    }

    const chars = [...display].map((ch, i) => {
        const proximity = 1.0 - Math.abs(i - center) / width;
        const clamped = Math.max(0, proximity);
        const intensity =
            (Math.cos(Math.PI * (1 - clamped)) + 1) / 2;

        let color: string;
        if (intensity < 0.5) {
            color = lerp3(BASE, GLOW, intensity * 2);
        } else {
            color = lerp3(GLOW, PEAK, (intensity - 0.5) * 2);
        }

        return (
            <Text key={i} color={color}>
                {ch}
            </Text>
        );
    });

    return <Text>{chars}</Text>;
}
