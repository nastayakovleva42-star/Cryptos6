import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, IChartApi, ISeriesApi, Time, MismatchDirection, Logical } from 'lightweight-charts';
import { getKlines, createKlineWebSocket } from '../services/binanceApi';
import { useChartStore } from '../store/chartStore';
import { DrawingTools, Drawing } from './DrawingTools';
import { useOrderBook } from '../hooks/useOrderBook';

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
};

function intervalToSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval] ?? 3600;
}

function snapTimeToKlines(time: number, newKlines: { time: number }[]) {
  const firstTime = newKlines[0].time / 1000;
  const lastTime = newKlines[newKlines.length - 1].time / 1000;
  if (time < firstTime || time > lastTime) return time;

  let closestCandle = newKlines[0];
  let minDistance = Math.abs(time - firstTime);

  for (const candle of newKlines) {
    const candleTime = candle.time / 1000;
    const distance = Math.abs(time - candleTime);
    if (distance < minDistance) {
      minDistance = distance;
      closestCandle = candle;
    }
  }

  return closestCandle.time / 1000;
}

function remapTimeForIntervalChange(
  time: number,
  newKlines: { time: number }[],
  oldLastTime: number | null,
  oldInterval: string | undefined,
  newInterval: string,
): number {
  const lastTime = newKlines[newKlines.length - 1].time / 1000;
  const firstTime = newKlines[0].time / 1000;
  const isFuture = time > lastTime || (oldLastTime !== null && time > oldLastTime);

  // Preserve how many bars the point sits beyond the last candle when the timeframe changes
  if (isFuture && oldInterval && oldInterval !== newInterval) {
    const oldDur = intervalToSeconds(oldInterval);
    const newDur = intervalToSeconds(newInterval);
    const basis = oldLastTime ?? lastTime;
    const offsetBars = (time - basis) / oldDur;
    return lastTime + offsetBars * newDur;
  }

  if (time < firstTime || time > lastTime) return time;
  return snapTimeToKlines(time, newKlines);
}

export function ChartComponent() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const obdContainerRef = useRef<HTMLDivElement>(null);

  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isRulerMode, setIsRulerMode] = useState(false);
  const [activeTool, setActiveTool] = useState('hline');
  const [color, setColor] = useState('#2962ff');
  const [lineWidth, setLineWidth] = useState(2);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [candlesLoaded, setCandlesLoaded] = useState(false);

  // Use refs for drawing state to avoid closure issues
  const isDrawingRef = useRef(false);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const middlePointRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const draggingPointIndexRef = useRef<number | null>(null);
  const selectedDrawingIdRef = useRef<string | null>(null);
  const drawingsRef = useRef<Drawing[]>([]);

  // Keep refs in sync with state
  useEffect(() => {
    selectedDrawingIdRef.current = selectedDrawingId;
  }, [selectedDrawingId]);

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  const { symbol, interval, trackedSymbols } = useChartStore();
  const { ratios } = useOrderBook(trackedSymbols || [symbol]);
  const currentRatio25 = ratios[symbol]?.['2.5'] || 0;
  const currentRatio5 = ratios[symbol]?.['5'] || 0;
  const currentRatio10 = ratios[symbol]?.['10'] || 0;
  const currentRatio25p = ratios[symbol]?.['25'] || 0;

  // Keep refs in sync with symbol and interval
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const colorRef = useRef(color);
  const lineWidthRef = useRef(lineWidth);
  const isObdInitialized = useRef(false);
  const lastBarTimeRef = useRef<number | null>(null);

  useEffect(() => {
    symbolRef.current = symbol;
    isObdInitialized.current = false;
  }, [symbol]);

  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

    useEffect(() => {
    if (obdContainerRef.current) {
      const s25 = (obdContainerRef.current as any).__series25;
      const s5 = (obdContainerRef.current as any).__series5;
      const s10 = (obdContainerRef.current as any).__series10;
      const s25p = (obdContainerRef.current as any).__series25p;
      const time = lastBarTimeRef.current;
      
      if (s25 && s5 && s10 && s25p && typeof time === 'number') {
        try {
          if (currentRatio25 !== 0 && !isNaN(currentRatio25)) s25.update({ time: time as Time, value: currentRatio25 });
          if (currentRatio5 !== 0 && !isNaN(currentRatio5)) s5.update({ time: time as Time, value: currentRatio5 });
          if (currentRatio10 !== 0 && !isNaN(currentRatio10)) s10.update({ time: time as Time, value: currentRatio10 });
          if (currentRatio25p !== 0 && !isNaN(currentRatio25p)) s25p.update({ time: time as Time, value: currentRatio25p });
        } catch (err) { console.warn("Ошибка обновления:", err); }
      }
    }
  }, [currentRatio25, currentRatio5, currentRatio10, currentRatio25p]);

  // Debounce timer for redraw
  const redrawTimerRef = useRef<number | null>(null);
  // Debounced redraw function
  const debouncedRedraw = () => {
    if (redrawTimerRef.current) {
      clearTimeout(redrawTimerRef.current);
    }
    redrawTimerRef.current = window.setTimeout(() => {
      redrawAll();
      redrawTimerRef.current = null;
    }, 16); // ~60fps
  };

  const getTimeScaleAnchor = () => {
    if (!chartRef.current || !candleSeriesRef.current) return null;
    const series = candleSeriesRef.current;
    const timeScale = chartRef.current.timeScale();
    const firstBar = series.dataByIndex(0, MismatchDirection.NearestRight);
    const lastBar = series.dataByIndex(Number.MAX_SAFE_INTEGER, MismatchDirection.NearestLeft);
    if (!firstBar || !lastBar) return null;

    const firstIndex = timeScale.timeToIndex(firstBar.time as Time, false);
    const lastIndex = timeScale.timeToIndex(lastBar.time as Time, false);
    if (firstIndex === null || lastIndex === null) return null;

    return {
      timeScale,
      firstTime: firstBar.time as number,
      lastTime: lastBar.time as number,
      firstIndex,
      lastIndex,
      duration: intervalToSeconds(intervalRef.current),
    };
  };

  const logicalToUnixTime = (logical: number): number | null => {
    const anchor = getTimeScaleAnchor();
    if (!anchor) return null;
    if (logical >= anchor.lastIndex) {
      return anchor.lastTime + (logical - anchor.lastIndex) * anchor.duration;
    }
    if (logical <= anchor.firstIndex) {
      return anchor.firstTime + (logical - anchor.firstIndex) * anchor.duration;
    }
    return anchor.firstTime + (logical - anchor.firstIndex) * anchor.duration;
  };

  const unixTimeToLogical = (time: number): number | null => {
    const anchor = getTimeScaleAnchor();
    if (!anchor) return null;
    if (time >= anchor.lastTime) {
      return anchor.lastIndex + (time - anchor.lastTime) / anchor.duration;
    }
    if (time <= anchor.firstTime) {
      return anchor.firstIndex + (time - anchor.firstTime) / anchor.duration;
    }
    return anchor.firstIndex + (time - anchor.firstTime) / anchor.duration;
  };

  // Helper functions to convert between pixel and chart coordinates
  const pixelToChart = (x: number, y: number): { time: number; price: number } | null => {
    if (!chartRef.current || !candleSeriesRef.current) return null;
    const timeScale = chartRef.current.timeScale();
    const price = candleSeriesRef.current.coordinateToPrice(y);
    if (price === null) return null;

    const mappedTime = timeScale.coordinateToTime(x);
    if (mappedTime !== null) {
      return { time: mappedTime as number, price };
    }

    const logical = timeScale.coordinateToLogical(x);
    if (logical === null) return null;
    const time = logicalToUnixTime(logical);
    if (time === null) return null;
    return { time, price };
  };

  const chartToPixel = (time: number, price: number): { x: number; y: number } | null => {
    if (!chartRef.current || !candleSeriesRef.current) return null;
    const timeScale = chartRef.current.timeScale();
    const y = candleSeriesRef.current.priceToCoordinate(price);
    if (y === null) return null;

    const mappedX = timeScale.timeToCoordinate(time as Time);
    if (mappedX !== null) {
      return { x: mappedX, y };
    }

    const logical = unixTimeToLogical(time);
    if (logical === null) return null;
    const x = timeScale.logicalToCoordinate(logical as Logical);
    if (x === null) return null;
    return { x, y };
  };

  // No need for fixAllDrawings anymore - drawings are created with chart coordinates immediately

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: '#0a0e17' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 15,
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350',
      borderDownColor: '#ef5350', borderUpColor: '#26a69a',
      wickDownColor: '#ef5350', wickUpColor: '#26a69a',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Create empty OBD chart panel
    if (obdContainerRef.current) {
      const obdChart = createChart(obdContainerRef.current, {
        layout: {
          background: { color: '#0a0e17' },
          textColor: '#d1d4dc',
        },
        grid: {
          vertLines: { color: '#1e222d' },
          horzLines: { color: '#1e222d' },
        },
        crosshair: {
          mode: 0,
          vertLine: {
            visible: true,
            labelVisible: true,
          },
          horzLine: {
            visible: true,
            labelVisible: true,
          },
        },
        timeScale: {
          borderColor: '#2a2e39',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 6,
          fixLeftEdge: false,
          fixRightEdge: false,
          lockVisibleTimeRangeOnResize: true,
          ticksVisible: true,
        },
        rightPriceScale: {
          borderColor: '#2a2e39',
          autoScale: true,
          scaleMargins: {
            top: 0.1,
            bottom: 0.1,
          },
          ticksVisible: true,
        },
        width: obdContainerRef.current.clientWidth,
        height: obdContainerRef.current.clientHeight,
      });

           // 2.5% - Красный
      const obdSeries25 = obdChart.addSeries(LineSeries, {
        color: '#ef5350', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceScaleId: 'right',
      });
      
      // 5% - Зеленый
      const obdSeries5 = obdChart.addSeries(LineSeries, {
        color: '#4caf50', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceScaleId: 'right',
      });

      // 10% - Синий
      const obdSeries10 = obdChart.addSeries(LineSeries, {
        color: '#2196f3', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceScaleId: 'right',
      });

      // 25% - Белый
      const obdSeries25p = obdChart.addSeries(LineSeries, {
        color: '#ffffff', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceScaleId: 'right',
      });

      obdSeries25.setData([]);
      obdSeries5.setData([]);
      obdSeries10.setData([]);
      obdSeries25p.setData([]);

      (obdContainerRef.current as any).__series25 = obdSeries25;
      (obdContainerRef.current as any).__series5 = obdSeries5;
      (obdContainerRef.current as any).__series10 = obdSeries10;
      (obdContainerRef.current as any).__series25p = obdSeries25p;
    
      // Configure the price scale to show -100 to +100 range
      obdChart.priceScale('right').applyOptions({
        visible: true,
        autoScale: true,
        invertScale: false,
        alignLabels: true,
        borderVisible: true,
        borderColor: '#2a2e39',
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
      });

      // Add horizontal lines at key levels
      const levels = [-100, -50, 0, 50, 100];
      levels.forEach(level => {
        obdSeries25.createPriceLine({
          price: level,
          color: level === 0 ? '#2a2e39' : '#1e222d',
          lineWidth: 1,
          lineStyle: level === 0 ? 2 : 0,
          axisLabelVisible: false,
          title: '',
        });
      });

      // Fit content to ensure proper scaling
      obdChart.timeScale().fitContent();

      // Sync time scale with main chart
            // Sync time scale with main chart (по логическим индексам)
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range) {
          obdChart.timeScale().setVisibleLogicalRange(range);
        }
      });

      // Sync from OBD to main chart as well
      obdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range) {
          chart.timeScale().setVisibleLogicalRange(range);
        }
      });

      // Sync crosshair between charts
            // Sync crosshair between charts
      chart.subscribeCrosshairMove((param) => {
        if (param.time) {
          try {
            obdChart.setCrosshairPosition(0, param.time, obdSeries);
          } catch (e) {
            // Игнорируем ошибку, если на нижнем графике еще нет данных
          }
        }
      });

      obdChart.subscribeCrosshairMove((param) => {
        if (param.time && candleSeriesRef.current) {
          try {
            chart.setCrosshairPosition(0, param.time, candleSeriesRef.current);
          } catch (e) {
            // Игнорируем ошибку
          }
        }
      });

      (obdContainerRef.current as any).__chart = obdChart;
      (obdContainerRef.current as any).__series25 = obdSeries25;
      (obdContainerRef.current as any).__series5 = obdSeries5;
    }

    // Initialize canvas size
    const initCanvas = () => {
      if (canvasRef.current && chartContainerRef.current) {
        canvasRef.current.width = chartContainerRef.current.clientWidth;
        canvasRef.current.height = chartContainerRef.current.clientHeight;
      }
    };

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
        initCanvas();
        redrawAll();
      }
      if (obdContainerRef.current) {
        const obdChart = (obdContainerRef.current as any).__chart;
        if (obdChart) {
          obdChart.applyOptions({
            width: obdContainerRef.current.clientWidth,
            height: obdContainerRef.current.clientHeight,
          });
        }
      }
    };
    window.addEventListener('resize', handleResize);

    // Subscribe to time scale changes to redraw fixed drawings with debounce
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      debouncedRedraw();
    });

    // Subscribe to crosshair move for price scale changes with debounce
    chart.subscribeCrosshairMove(() => {
      debouncedRedraw();
    });

    // Initialize canvas after a short delay to ensure it's rendered
    setTimeout(initCanvas, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (redrawTimerRef.current) {
        clearTimeout(redrawTimerRef.current);
      }
      if (obdContainerRef.current) {
        const obdChart = (obdContainerRef.current as any).__chart;
        if (obdChart) {
          obdChart.remove();
        }
      }
      chart.remove();
    };
  }, []);

  // Function to draw all saved drawings
  const redrawAll = () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Use refs to get current values
    const currentDrawings = drawingsRef.current;
    const currentSelectedId = selectedDrawingIdRef.current;

    // Draw all saved drawings for current symbol
    currentDrawings.forEach(drawing => {
      // Skip drawings from other symbols or drawings without symbol
      if (!drawing.symbol || drawing.symbol !== symbolRef.current) return;

      const isSelected = drawing.id === currentSelectedId;
      ctx.strokeStyle = drawing.color;
      ctx.lineWidth = drawing.lineWidth;
      ctx.setLineDash([]);

      // Convert points to pixel coordinates
      let pixels: { x: number; y: number }[];

      if (drawing.fixed) {
        // Convert chart coordinates (time/price stored in x/y) to pixels
        pixels = drawing.points.map(p => {
          const pixel = chartToPixel(p.x, p.y);
          return pixel || { x: 0, y: 0 };
        });
      } else {
        // Already in pixel coordinates
        pixels = drawing.points;
      }

      // Draw selection highlight
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = drawing.lineWidth + 2;
        ctx.setLineDash([5, 5]);
      }

      if (drawing.type === 'hline' && pixels.length >= 1) {
        const y = pixels[0].y;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      } else if (drawing.type === 'vline' && pixels.length >= 1) {
        const x = pixels[0].x;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      } else if (drawing.type === 'line' && pixels.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pixels[0].x, pixels[0].y);
        ctx.lineTo(pixels[1].x, pixels[1].y);
        ctx.stroke();
      } else if (drawing.type === 'ray' && pixels.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pixels[0].x, pixels[0].y);
        const dx = pixels[1].x - pixels[0].x;
        const dy = pixels[1].y - pixels[0].y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          const extendX = pixels[0].x + (dx / length) * 2000;
          const extendY = pixels[0].y + (dy / length) * 2000;
          ctx.lineTo(extendX, extendY);
        }
        ctx.stroke();
      } else if (drawing.type === 'fib' && pixels.length >= 2) {
        const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const y1 = pixels[0].y;
        const y2 = pixels[1].y;
        const x1 = pixels[0].x;
        const x2 = pixels[1].x;

        fibLevels.forEach(level => {
          // Invert level: 0% should be at y2 (end), 100% at y1 (start)
          const invertedLevel = 1 - level;
          const y = y1 + (y2 - y1) * invertedLevel;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();

          // Draw level label
          ctx.fillStyle = drawing.color;
          ctx.font = '10px sans-serif';
          ctx.fillText(`${(level * 100).toFixed(1)}%`, x2 + 5, y + 3);
        });
      } else if (drawing.type === 'rect' && pixels.length >= 2) {
        // Draw semi-transparent rectangle without border
        const x1 = pixels[0].x;
        const y1 = pixels[0].y;
        const x2 = pixels[1].x;
        const y2 = pixels[1].y;
        const width = x2 - x1;
        const height = y2 - y1;

        // Parse color and add transparency
        const tempColor = drawing.color;
        ctx.fillStyle = tempColor + '40'; // 25% opacity
        ctx.fillRect(x1, y1, width, height);
      } else if (drawing.type === 'channel' && pixels.length >= 3) {
        // Draw parallel channel
        // Point 0 and Point 1 define the center line
        // Point 2 defines the width (perpendicular distance to center line)
        const x1 = pixels[0].x;
        const y1 = pixels[0].y;
        const x2 = pixels[1].x;
        const y2 = pixels[1].y;
        const x3 = pixels[2].x;
        const y3 = pixels[2].y;

        // Calculate direction vector of the center line
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);

        if (length > 0) {
          // Calculate perpendicular distance from point 2 to the center line
          // Formula: |(y2-y1)*x3 - (x2-x1)*y3 + (x2-x1)*y1 - (y2-y1)*x1| / length
          const numerator = Math.abs((y2 - y1) * x3 - (x2 - x1) * y3 + (x2 - x1) * y1 - (y2 - y1) * x1);
          const halfWidth = numerator / length;

          // Calculate perpendicular unit vector
          const perpX = -dy / length;
          const perpY = dx / length;

          // Calculate offset for channel boundaries (symmetric around center line)
          const offsetX = perpX * halfWidth;
          const offsetY = perpY * halfWidth;

          // Draw semi-transparent fill between boundaries
          ctx.fillStyle = drawing.color + '30';
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.lineTo(x1 - offsetX, y1 - offsetY);
          ctx.closePath();
          ctx.fill();

          // Draw center line (point 0 to point 1)
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Draw upper boundary
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.stroke();

          // Draw lower boundary
          ctx.beginPath();
          ctx.moveTo(x1 - offsetX, y1 - offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.stroke();
        }
      } else if (drawing.type === 'ruler' && pixels.length >= 2) {
        // Draw ruler rectangle
        const startX = Math.min(pixels[0].x, pixels[1].x);
        const startY = Math.min(pixels[0].y, pixels[1].y);
        const width = Math.abs(pixels[1].x - pixels[0].x);
        const height = Math.abs(pixels[1].y - pixels[0].y);

        // Calculate price change to determine color
        let priceChange: number;
        if (drawing.fixed) {
          // For fixed drawings, use the stored prices directly
          // points[0] is start, points[1] is end
          priceChange = ((drawing.points[1].y - drawing.points[0].y) / drawing.points[0].y) * 100;
        } else {
          // For non-fixed, convert pixel y to price
          const price1 = candleSeriesRef.current?.coordinateToPrice(drawing.points[0].y);
          const price2 = candleSeriesRef.current?.coordinateToPrice(drawing.points[1].y);
          if (price1 !== null && price1 !== undefined && price2 !== null && price2 !== undefined) {
            priceChange = ((price2 - price1) / price1) * 100;
          } else {
            priceChange = 0;
          }
        }
        const isPositive = priceChange >= 0;

        // Ensure minimum visible size for 0% rulers
        const minVisibleHeight = 4;
        const effectiveHeight = Math.max(height, minVisibleHeight);
        const adjustedStartY = height < minVisibleHeight ? startY - minVisibleHeight / 2 : startY;

        // Fill rectangle with color based on direction
        ctx.fillStyle = isPositive ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)';
        ctx.fillRect(startX, adjustedStartY, width, effectiveHeight);

        // Stroke rectangle with color based on direction
        ctx.strokeStyle = isPositive ? '#26a69a' : '#ef5350';
        ctx.lineWidth = drawing.lineWidth;
        ctx.setLineDash([]);
        ctx.strokeRect(startX, adjustedStartY, width, effectiveHeight);

        // Calculate measurements
        const barCount = Math.abs(pixels[1].x - pixels[0].x);

        // Convert bars to time based on interval
        let timeText = '';
        if (intervalRef.current === '1m') timeText = `${barCount} мин`;
        else if (intervalRef.current === '5m') timeText = `${barCount * 5} мин`;
        else if (intervalRef.current === '15m') timeText = `${barCount * 15} мин`;
        else if (intervalRef.current === '30m') timeText = `${barCount * 30} мин`;
        else if (intervalRef.current === '1h') timeText = `${barCount} ч`;
        else if (intervalRef.current === '4h') timeText = `${barCount * 4} ч`;
        else if (intervalRef.current === '1d') timeText = `${barCount} дн`;
        else if (intervalRef.current === '1w') timeText = `${barCount} нед`;
        else timeText = `${barCount} баров`;

        // Draw measurement info
        const midX = startX + width / 2;
        const midY = startY + height / 2;

        // Background for text
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(midX - 60, midY - 25, 120, 50);

        // Color based on price change direction
        const percentColor = priceChange >= 0 ? '#26a69a' : '#ef5350';
        const percentText = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;

        // Text
        ctx.fillStyle = percentColor;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(percentText, midX, midY - 5);
        ctx.fillStyle = drawing.color;
        ctx.font = '12px sans-serif';
        ctx.fillText(timeText, midX, midY + 15);
        ctx.textAlign = 'left';
      }

      // Draw control points if selected
      if (isSelected) {
        pixels.forEach((point, idx) => {
          const isBeingDragged = isDraggingRef.current && draggingPointIndexRef.current === idx;

          ctx.fillStyle = isBeingDragged ? '#ef4444' : '#3b82f6';
          ctx.beginPath();
          ctx.arc(point.x, point.y, isBeingDragged ? 7 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      }

      // Restore context if drawing was selected
      if (isSelected) {
        ctx.restore();
      }
    });
  };

  // Redraw when drawings, selection, tool, or symbol changes
  useEffect(() => {
    redrawAll();
  }, [drawings, selectedDrawingId, activeTool, interval, symbol]);

  // Handle Delete key to remove selected or last drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete') {
        if (selectedDrawingId) {
          setDrawings(prev => prev.filter(d => d.id !== selectedDrawingId));
          setSelectedDrawingId(null);
        } else if (drawings.length > 0) {
          setDrawings(prev => prev.slice(0, -1));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawings.length, selectedDrawingId]);

  // Canvas mouse event handlers
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;

    // If not in drawing or ruler mode, don't attach handlers
    if (!isDrawingMode && !isRulerMode) {
      // Reset drawing state
      isDraggingRef.current = false;
      draggingPointIndexRef.current = null;
      canvas.style.cursor = 'default';
      return;
    }

    // Ruler mode - separate handling
    if (isRulerMode) {
      canvas.style.cursor = 'crosshair';

      const handleRulerMouseDown = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        isDrawingRef.current = true;
        startPointRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      const handleRulerMouseMove = (e: MouseEvent) => {
        if (!isDrawingRef.current || !startPointRef.current) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Redraw all saved drawings first
        redrawAll();

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Draw preview ruler
        const startX = Math.min(startPointRef.current.x, x);
        const startY = Math.min(startPointRef.current.y, y);
        const width = Math.abs(x - startPointRef.current.x);
        const height = Math.abs(y - startPointRef.current.y);

        // Calculate price change for preview
        const startPrice = candleSeriesRef.current?.coordinateToPrice(startPointRef.current.y);
        const endPrice = candleSeriesRef.current?.coordinateToPrice(y);
        let priceChange = 0;
        if (startPrice != null && endPrice != null && startPrice !== 0) {
          priceChange = ((endPrice - startPrice) / startPrice) * 100;
        }
        const isPositive = priceChange >= 0;

        // Fill rectangle with color based on direction
        ctx.fillStyle = isPositive ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)';
        ctx.fillRect(startX, startY, width, height);

        // Stroke rectangle with color based on direction
        ctx.strokeStyle = isPositive ? '#26a69a' : '#ef5350';
        ctx.lineWidth = lineWidthRef.current;
        ctx.setLineDash([]);
        ctx.strokeRect(startX, startY, width, height);

        // Calculate measurements
        const barCount = Math.abs(x - startPointRef.current.x);

        // Convert bars to time based on interval
        let timeText = '';
        if (intervalRef.current === '1m') timeText = `${barCount} мин`;
        else if (intervalRef.current === '5m') timeText = `${barCount * 5} мин`;
        else if (intervalRef.current === '15m') timeText = `${barCount * 15} мин`;
        else if (intervalRef.current === '30m') timeText = `${barCount * 30} мин`;
        else if (intervalRef.current === '1h') timeText = `${barCount} ч`;
        else if (intervalRef.current === '4h') timeText = `${barCount * 4} ч`;
        else if (intervalRef.current === '1d') timeText = `${barCount} дн`;
        else if (intervalRef.current === '1w') timeText = `${barCount} нед`;
        else timeText = `${barCount} баров`;

        // Draw measurement info
        const midX = startX + width / 2;
        const midY = startY + height / 2;

        // Background for text
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(midX - 60, midY - 25, 120, 50);

        // Color based on price change direction
        const percentColor = priceChange >= 0 ? '#26a69a' : '#ef5350';
        const percentText = priceChange >= 0 ? `+${priceChange.toFixed(2)}%` : `${priceChange.toFixed(2)}%`;

        // Text
        ctx.fillStyle = percentColor;
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(percentText, midX, midY - 5);
        ctx.fillStyle = colorRef.current;
        ctx.font = '12px sans-serif';
        ctx.fillText(timeText, midX, midY + 15);
        ctx.textAlign = 'left';
      };

      const handleRulerMouseUp = (e: MouseEvent) => {
        if (!isDrawingRef.current || !startPointRef.current) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Convert to chart coordinates immediately
        const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);
        const endChartCoords = pixelToChart(x, y);

        if (startChartCoords && endChartCoords) {
          const newDrawing: Drawing = {
            id: Date.now().toString(),
            type: 'ruler',
            points: [
              { x: startChartCoords.time, y: startChartCoords.price },
              { x: endChartCoords.time, y: endChartCoords.price }
            ],
            color: colorRef.current,
            lineWidth: lineWidthRef.current,
            interval: interval,
            symbol: symbol,
            fixed: true,
          };

          setDrawings(prev => [...prev, newDrawing]);
        }

        isDrawingRef.current = false;
        startPointRef.current = null;
      };

      canvas.addEventListener('mousedown', handleRulerMouseDown);
      canvas.addEventListener('mousemove', handleRulerMouseMove);
      window.addEventListener('mouseup', handleRulerMouseUp);

      return () => {
        canvas.removeEventListener('mousedown', handleRulerMouseDown);
        canvas.removeEventListener('mousemove', handleRulerMouseMove);
        window.removeEventListener('mouseup', handleRulerMouseUp);
      };
    }

    // Drawing mode - cursor tool for selection and dragging
    if (activeTool === 'cursor') {
      const handleSelectClick = (e: MouseEvent) => {
        e.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const tolerance = 10;
        let foundDrawing: string | null = null;

        // Check each drawing to see if clicked near it
        for (const drawing of drawings) {
          if (!drawing.symbol || drawing.symbol !== symbolRef.current) continue;

          let pixels: { x: number; y: number }[];
          if (drawing.fixed) {
            pixels = drawing.points.map(p => {
              const pixel = chartToPixel(p.x, p.y);
              return pixel || { x: 0, y: 0 };
            });
          } else {
            pixels = drawing.points;
          }

          if (drawing.type === 'hline' && pixels.length >= 1) {
            if (Math.abs(y - pixels[0].y) < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'vline' && pixels.length >= 1) {
            if (Math.abs(x - pixels[0].x) < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if ((drawing.type === 'line' || drawing.type === 'ray') && pixels.length >= 2) {
            // Check distance to line segment
            const A = x - pixels[0].x;
            const B = y - pixels[0].y;
            const C = pixels[1].x - pixels[0].x;
            const D = pixels[1].y - pixels[0].y;

            const dot = A * C + B * D;
            const len_sq = C * C + D * D;
            const param = len_sq !== 0 ? dot / len_sq : -1;

            let xx, yy;
            if (param < 0) {
              xx = pixels[0].x;
              yy = pixels[0].y;
            } else if (param > 1) {
              xx = pixels[1].x;
              yy = pixels[1].y;
            } else {
              xx = pixels[0].x + param * C;
              yy = pixels[0].y + param * D;
            }

            const distance = Math.sqrt((x - xx) ** 2 + (y - yy) ** 2);
            if (distance < tolerance) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'fib' && pixels.length >= 2) {
            // Check if clicked near any fib level
            const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            for (const level of fibLevels) {
              const invertedLevel = 1 - level;
              const fy = pixels[0].y + (pixels[1].y - pixels[0].y) * invertedLevel;
              if (Math.abs(y - fy) < tolerance && x >= Math.min(pixels[0].x, pixels[1].x) && x <= Math.max(pixels[0].x, pixels[1].x)) {
                foundDrawing = drawing.id;
                break;
              }
            }
            if (foundDrawing) break;
          } else if (drawing.type === 'rect' && pixels.length >= 2) {
            const minX = Math.min(pixels[0].x, pixels[1].x);
            const maxX = Math.max(pixels[0].x, pixels[1].x);
            const minY = Math.min(pixels[0].y, pixels[1].y);
            const maxY = Math.max(pixels[0].y, pixels[1].y);

            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              foundDrawing = drawing.id;
              break;
            }
          } else if (drawing.type === 'ruler' && pixels.length >= 2) {
            // Check if clicked near corners or inside rectangle
            const dist1 = Math.sqrt((x - pixels[0].x) ** 2 + (y - pixels[0].y) ** 2);
            const dist2 = Math.sqrt((x - pixels[1].x) ** 2 + (y - pixels[1].y) ** 2);
            if (dist1 < 20 || dist2 < 20) {
              foundDrawing = drawing.id;
              break;
            }
            // Check if inside rectangle
            const startX = Math.min(pixels[0].x, pixels[1].x);
            const startY = Math.min(pixels[0].y, pixels[1].y);
            const width = Math.abs(pixels[1].x - pixels[0].x);
            const height = Math.abs(pixels[1].y - pixels[0].y);
            if (x >= startX && x <= startX + width && y >= startY && y <= startY + height) {
              foundDrawing = drawing.id;
              break;
            }
          }
        }

        setSelectedDrawingId(foundDrawing);
        redrawAll();
      };

      const handleMouseDown = (e: MouseEvent) => {
        // Only allow dragging if a drawing is selected
        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) return;

        e.preventDefault();
        e.stopPropagation();

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Find the selected drawing
        const drawing = drawingsRef.current.find(d => d.id === currentSelectedId);
        if (!drawing || !drawing.symbol || drawing.symbol !== symbolRef.current) return;

        let pixels: { x: number; y: number }[];
        if (drawing.fixed) {
          pixels = drawing.points.map(p => {
            const pixel = chartToPixel(p.x, p.y);
            return pixel || { x: 0, y: 0 };
          });
        } else {
          pixels = drawing.points;
        }

        // Check if clicked near any control point
        for (let i = 0; i < pixels.length; i++) {
          const distance = Math.sqrt((x - pixels[i].x) ** 2 + (y - pixels[i].y) ** 2);
          if (distance < 10) {
            isDraggingRef.current = true;
            draggingPointIndexRef.current = i;
            canvas.style.cursor = 'grabbing';
            break;
          }
        }
      };

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDraggingRef.current || draggingPointIndexRef.current === null) return;

        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) return;

        e.preventDefault();

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Update the drawing
        setDrawings(prev => prev.map(d => {
          if (d.id === currentSelectedId) {
            const newPoints = [...d.points];
            if (d.fixed) {
              // Convert pixel to chart coordinates
              const chartCoords = pixelToChart(x, y);
              if (chartCoords) {
                newPoints[draggingPointIndexRef.current!] = {
                  x: chartCoords.time,
                  y: chartCoords.price
                };
              }
            } else {
              // Update pixel coordinates directly
              newPoints[draggingPointIndexRef.current!] = { x, y };
            }
            return { ...d, points: newPoints };
          }
          return d;
        }));
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        draggingPointIndexRef.current = null;
        canvas.style.cursor = 'pointer';
      };

      const handleMouseHover = (e: MouseEvent) => {
        if (isDraggingRef.current) return;

        const currentSelectedId = selectedDrawingIdRef.current;
        if (!currentSelectedId) {
          canvas.style.cursor = 'pointer';
          return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Find the selected drawing
        const drawing = drawingsRef.current.find(d => d.id === currentSelectedId);
        if (!drawing || !drawing.symbol || drawing.symbol !== symbolRef.current) {
          canvas.style.cursor = 'pointer';
          return;
        }

        let pixels: { x: number; y: number }[];
        if (drawing.fixed) {
          pixels = drawing.points.map(p => {
            const pixel = chartToPixel(p.x, p.y);
            return pixel || { x: 0, y: 0 };
          });
        } else {
          pixels = drawing.points;
        }

        // Check if hovering near any control point
        let nearPoint = false;
        for (let i = 0; i < pixels.length; i++) {
          const distance = Math.sqrt((x - pixels[i].x) ** 2 + (y - pixels[i].y) ** 2);
          if (distance < 10) {
            nearPoint = true;
            break;
          }
        }

        canvas.style.cursor = nearPoint ? 'grab' : 'pointer';
      };

      canvas.addEventListener('click', handleSelectClick);
      canvas.addEventListener('mousedown', handleMouseDown);
      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mousemove', handleMouseHover);
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        canvas.removeEventListener('click', handleSelectClick);
        canvas.removeEventListener('mousedown', handleMouseDown);
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mousemove', handleMouseHover);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }

    // Drawing mode - other tools
    const handleDrawMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // For channel tool, need 3 clicks
      if (activeTool === 'channel') {
        // First click - start point
        if (!startPointRef.current) {
          startPointRef.current = { x, y };
          isDrawingRef.current = true;
          return;
        }

        // Second click - end point of center line
        if (!middlePointRef.current) {
          middlePointRef.current = { x, y };
          return;
        }

        // Third click - width point
        const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);
        const middleChartCoords = pixelToChart(middlePointRef.current.x, middlePointRef.current.y);
        const endChartCoords = pixelToChart(x, y);

        if (startChartCoords && middleChartCoords && endChartCoords) {
          const newDrawing: Drawing = {
            id: Date.now().toString(),
            type: 'channel',
            points: [
              { x: startChartCoords.time, y: startChartCoords.price },
              { x: middleChartCoords.time, y: middleChartCoords.price },
              { x: endChartCoords.time, y: endChartCoords.price }
            ],
            color: colorRef.current,
            lineWidth: lineWidthRef.current,
            interval: interval,
            symbol: symbol,
            fixed: true,
          };

          setDrawings(prev => [...prev, newDrawing]);
        }

        // Reset all state
        isDrawingRef.current = false;
        startPointRef.current = null;
        middlePointRef.current = null;
        return;
      }

      // For other tools, use normal logic
      isDrawingRef.current = true;
      startPointRef.current = { x, y };
    };

    const handleDrawMouseMove = (e: MouseEvent) => {
      // For channel, need at least start point
      if (activeTool === 'channel') {
        if (!startPointRef.current) return;
      } else {
        // For other tools, need start point and drawing active
        if (!isDrawingRef.current || !startPointRef.current) return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Redraw all saved drawings first
      redrawAll();

      // Draw preview
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = lineWidthRef.current;
      ctx.setLineDash([5, 5]);

      if (activeTool === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      } else if (activeTool === 'vline') {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      } else if (activeTool === 'line') {
        ctx.beginPath();
        ctx.moveTo(startPointRef.current.x, startPointRef.current.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else if (activeTool === 'ray') {
        ctx.beginPath();
        ctx.moveTo(startPointRef.current.x, startPointRef.current.y);
        const dx = x - startPointRef.current.x;
        const dy = y - startPointRef.current.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          const extendX = startPointRef.current.x + (dx / length) * 2000;
          const extendY = startPointRef.current.y + (dy / length) * 2000;
          ctx.lineTo(extendX, extendY);
        }
        ctx.stroke();
      } else if (activeTool === 'fib') {
        const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const y1 = startPointRef.current.y;
        const x1 = startPointRef.current.x;

        fibLevels.forEach(level => {
          // Invert level: 0% should be at y (end), 100% at y1 (start)
          const invertedLevel = 1 - level;
          const fy = y1 + (y - y1) * invertedLevel;
          ctx.beginPath();
          ctx.moveTo(x1, fy);
          ctx.lineTo(x, fy);
          ctx.stroke();
        });
      } else if (activeTool === 'rect') {
        // Draw semi-transparent rectangle preview without border
        const x1 = startPointRef.current.x;
        const y1 = startPointRef.current.y;
        const width = x - x1;
        const height = y - y1;

        ctx.fillStyle = colorRef.current + '40'; // 25% opacity
        ctx.fillRect(x1, y1, width, height);
      } else if (activeTool === 'channel') {
        // Draw parallel channel preview
        const x1 = startPointRef.current.x;
        const y1 = startPointRef.current.y;

        // If middle point is set, draw channel from start to middle
        let x2, y2;
        if (middlePointRef.current) {
          x2 = middlePointRef.current.x;
          y2 = middlePointRef.current.y;
        } else {
          x2 = x;
          y2 = y;
        }

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);

        if (length > 0) {
          // Calculate perpendicular distance from current mouse position to the line
          let perpDist;

          if (middlePointRef.current) {
            // After second click, use distance from mouse to line as width
            const numerator = Math.abs((y2 - y1) * x - (x2 - x1) * y + (x2 - x1) * y1 - (y2 - y1) * x1);
            perpDist = numerator / length;
          } else {
            // Before second click, use 30% of line length as preview width
            perpDist = length * 0.3;
          }

          // Calculate perpendicular unit vector
          const perpX = -dy / length;
          const perpY = dx / length;

          // Calculate offset for channel boundaries (symmetric around center line)
          const offsetX = perpX * perpDist;
          const offsetY = perpY * perpDist;

          // Semi-transparent fill
          ctx.fillStyle = colorRef.current + '30';
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.lineTo(x1 - offsetX, y1 - offsetY);
          ctx.closePath();
          ctx.fill();

          // Middle line
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Upper line
          ctx.beginPath();
          ctx.moveTo(x1 + offsetX, y1 + offsetY);
          ctx.lineTo(x2 + offsetX, y2 + offsetY);
          ctx.stroke();

          // Lower line
          ctx.beginPath();
          ctx.moveTo(x1 - offsetX, y1 - offsetY);
          ctx.lineTo(x2 - offsetX, y2 - offsetY);
          ctx.stroke();
        }
      }

      ctx.setLineDash([]);
    };

    const handleDrawMouseUp = (e: MouseEvent) => {
      // Skip channel logic - handled in mousedown
      if (activeTool === 'channel') return;

      if (!isDrawingRef.current || !startPointRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert end point to chart coordinates immediately
      const endChartCoords = pixelToChart(x, y);
      const startChartCoords = pixelToChart(startPointRef.current.x, startPointRef.current.y);

      // Create new drawing for other tools with chart coordinates
      const newDrawing: Drawing = {
        id: Date.now().toString(),
        type: activeTool,
        points: [],
        color: colorRef.current,
        lineWidth: lineWidthRef.current,
        interval: interval,
        symbol: symbol,
        fixed: true,
      };

      if (activeTool === 'hline') {
        if (endChartCoords) {
          newDrawing.points = [{ x: endChartCoords.time, y: endChartCoords.price }];
        }
      } else if (activeTool === 'vline') {
        if (endChartCoords) {
          newDrawing.points = [{ x: endChartCoords.time, y: endChartCoords.price }];
        }
      } else if (activeTool === 'line' || activeTool === 'ray' || activeTool === 'fib' || activeTool === 'rect') {
        if (startChartCoords && endChartCoords) {
          newDrawing.points = [
            { x: startChartCoords.time, y: startChartCoords.price },
            { x: endChartCoords.time, y: endChartCoords.price }
          ];
        }
      }

      // Save drawing only if we have valid points
      if (newDrawing.points.length > 0) {
        setDrawings(prev => [...prev, newDrawing]);
      }

      isDrawingRef.current = false;
      startPointRef.current = null;
    };

    canvas.addEventListener('mousedown', handleDrawMouseDown);
    canvas.addEventListener('mousemove', handleDrawMouseMove);
    canvas.addEventListener('mouseup', handleDrawMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', handleDrawMouseDown);
      canvas.removeEventListener('mousemove', handleDrawMouseMove);
      canvas.removeEventListener('mouseup', handleDrawMouseUp);
    };
  }, [isDrawingMode, isRulerMode, activeTool]);

  // Save drawings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('chartDrawings', JSON.stringify(drawings));
  }, [drawings]);

  // Adapt drawings to new timeframe
  const adaptDrawingsToTimeframe = useCallback((newKlines: { time: number }[]) => {
    if (newKlines.length === 0) return;

    const oldLastTime = lastBarTimeRef.current;
    const newInterval = intervalRef.current;

    setDrawings(prevDrawings => {
      return prevDrawings.map(drawing => {
        if (!drawing.fixed) return drawing;
        if (drawing.symbol && drawing.symbol !== symbolRef.current) return drawing;

        // For horizontal lines, keep the price, just update time to middle of visible range
        if (drawing.type === 'hline' && drawing.points.length >= 1) {
          const price = drawing.points[0].y;
          const middleIndex = Math.floor(newKlines.length / 2);
          const middleTime = newKlines[middleIndex].time / 1000;

          return {
            ...drawing,
            interval: newInterval,
            points: [{ x: middleTime, y: price }]
          };
        }

        return {
          ...drawing,
          interval: newInterval,
          points: drawing.points.map(point => ({
            x: remapTimeForIntervalChange(
              point.x,
              newKlines,
              oldLastTime,
              drawing.interval,
              newInterval,
            ),
            y: point.y
          }))
        };
      });
    });
  }, []);

  // Load data
  useEffect(() => {
    const loadData = async () => {
      try {
        setCandlesLoaded(false);

        // Load 2000 candles (will make multiple requests if needed)
        const data = await getKlines(symbol, interval, 2000);

        setCandlesLoaded(true);

        // Adapt drawings to new timeframe
        adaptDrawingsToTimeframe(data);

        if (candleSeriesRef.current && chartRef.current) {
          const candleData = data.map(d => ({
            time: (d.time / 1000) as Time, open: d.open, high: d.high, low: d.low, close: d.close,
          }));
          const volumeData = data.map(d => ({
            time: (d.time / 1000) as Time, value: d.volume,
            color: d.close >= d.open ? 'rgba(38, 166, 154, 0.3)' : 'rgba(239, 83, 80, 0.3)',
          }));

          candleSeriesRef.current.setData(candleData);
          volumeSeriesRef.current?.setData(volumeData);
          lastBarTimeRef.current = candleData.length > 0
            ? (candleData[candleData.length - 1].time as number)
            : null;
                    if (obdContainerRef.current && candleData.length > 0) {
            const s25 = (obdContainerRef.current as any).__series25;
            const s5 = (obdContainerRef.current as any).__series5;
            const s10 = (obdContainerRef.current as any).__series10;
            const s25p = (obdContainerRef.current as any).__series25p;
            
            if (s25 && s5 && s10 && s25p) {
              const makeZeroArr = () => candleData.map(c => ({ time: c.time, value: 0 }));
              const obdData25 = makeZeroArr();
              const obdData5 = makeZeroArr();
              const obdData10 = makeZeroArr();
              const obdData25p = makeZeroArr();

              const savedHistoryStr = localStorage.getItem('obd_history');
              const savedHistory = savedHistoryStr ? JSON.parse(savedHistoryStr) : {};
              const symHistory = savedHistory[symbol] || {};
              
              const getHist = (key: string) => Array.isArray(symHistory) ? (key === '2.5' ? symHistory : []) : (symHistory[key] || []);
              const h25 = getHist('2.5');
              const h5 = getHist('5');
              const h10 = getHist('10');
              const h25p = getHist('25');

              const applyHistory = (dataArr: any[], historyArr: any[]) => {
                historyArr.forEach((pt: any) => {
                  let closestIdx = -1, minDiff = Infinity;
                  dataArr.forEach((candle, idx) => {
                    const diff = Math.abs(candle.time - pt.time);
                    if (diff < minDiff) { minDiff = diff; closestIdx = idx; }
                  });
                  if (closestIdx !== -1 && minDiff <= 300) dataArr[closestIdx].value = pt.value;
                });
              };

              applyHistory(obdData25, h25);
              applyHistory(obdData5, h5);
              applyHistory(obdData10, h10);
              applyHistory(obdData25p, h25p);

              s25.setData(obdData25);
              s5.setData(obdData5);
              s10.setData(obdData10);
              s25p.setData(obdData25p);
              isObdInitialized.current = true;
            }
          }
          // Автоскейл ТОЛЬКО для основного графика (с задержкой для правильного размера)
          setTimeout(() => {
            try {
              if (chartRef.current) {
                chartRef.current.timeScale().fitContent();
                chartRef.current.priceScale('right').applyOptions({
                  autoScale: true,
                });
              }
            } catch (e) {
              // Игнорируем ошибку, если график уже уничтожен
            }
          }, 100);

          // Sync OBD chart time scale with main chart
          if (obdContainerRef.current) {
            const obdChart = (obdContainerRef.current as any).__chart;
            if (obdChart) {
              const visibleRange = chartRef.current.timeScale().getVisibleLogicalRange();
              if (visibleRange) {
                obdChart.timeScale().setVisibleLogicalRange(visibleRange);
              }
  
              }
            }
          }

          // Force redraw after data load to show drawings for current timeframe
          setTimeout(() => {
            redrawAll();
          }, 50);
      } catch (e) {
        console.error('Failed to load klines:', e);
      }
    };

    loadData();

    // WebSocket
    if (wsRef.current) wsRef.current.close();
    wsRef.current = createKlineWebSocket(symbol, interval, (kline) => {
      if (candleSeriesRef.current) {
        const timeInSeconds = Math.floor(kline.time / 1000);
        candleSeriesRef.current.update({
          time: timeInSeconds as Time,
          open: kline.open, high: kline.high, low: kline.low, close: kline.close,
        });
        lastBarTimeRef.current = timeInSeconds;
      }
    });

    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [symbol, interval, adaptDrawingsToTimeframe]);
  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      <div className="flex-1 flex overflow-hidden min-h-0">
        <DrawingTools
          activeTool={activeTool}
          onToolSelect={setActiveTool}
          isDrawingMode={isDrawingMode}
          onToggleDrawingMode={() => {
            setIsDrawingMode(!isDrawingMode);
            if (!isDrawingMode) {
              setActiveTool('hline');
            }
          }}
          color={color}
          onColorChange={setColor}
          lineWidth={lineWidth}
          onLineWidthChange={(width) => {
            setLineWidth(width);
            if (selectedDrawingId) {
              setDrawings(prev => prev.map(d =>
                d.id === selectedDrawingId ? { ...d, lineWidth: width } : d
              ));
            }
          }}
          drawings={drawings}
          onDeleteDrawing={(id) => {
            setDrawings(prev => prev.filter(d => d.id !== id));
            if (selectedDrawingId === id) {
              setSelectedDrawingId(null);
            }
          }}
          onClearAll={() => {
            setDrawings([]);
            setSelectedDrawingId(null);
          }}
          selectedDrawingId={selectedDrawingId}
          onSelectDrawing={setSelectedDrawingId}
          isRulerMode={isRulerMode}
          onToggleRulerMode={() => {
            setIsRulerMode(!isRulerMode);
          }}
        />

        {/* Chart Area with OBD Panel */}
        <div className="flex-1 flex flex-col relative">
          <div className="flex-1 relative min-h-0">
            <div ref={chartContainerRef} className="w-full h-full" />

            {/* Canvas Overlay for Drawing */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 z-10"
              style={{
                pointerEvents: (isDrawingMode || isRulerMode) ? 'auto' : 'none',
                cursor: isRulerMode ? 'crosshair' : (isDrawingMode ? (activeTool === 'cursor' ? 'pointer' : 'crosshair') : 'default')
              }}
            />
          </div>

          {/* OBD Indicator Panel */}
          <div className="h-[110px] border-t-2 border-[#2a2e39] relative shrink-0">
                        <div className="absolute top-2 left-2 z-10 text-xs text-gray-400 bg-[#0a0e17] px-2 py-1 rounded flex items-center gap-4 shadow-lg border border-[#2a2e39]">
              <span className="flex items-center gap-1">
                OBD 2.5%: <span className="text-[#ef5350] font-bold">{ratios[symbol]?.['2.5'] !== undefined ? ratios[symbol]['2.5'].toFixed(2) : '...'}</span>
              </span>
              <span className="flex items-center gap-1">
                OBD 5%: <span className="text-[#4caf50] font-bold">{ratios[symbol]?.['5'] !== undefined ? ratios[symbol]['5'].toFixed(2) : '...'}</span>
              </span>
              <span className="flex items-center gap-1">
                OBD 10%: <span className="text-[#2196f3] font-bold">{ratios[symbol]?.['10'] !== undefined ? ratios[symbol]['10'].toFixed(2) : '...'}</span>
              </span>
              <span className="flex items-center gap-1">
                OBD 25%: <span className="text-[#ffffff] font-bold">{ratios[symbol]?.['25'] !== undefined ? ratios[symbol]['25'].toFixed(2) : '...'}</span>
              </span>
            </div>
            <div ref={obdContainerRef} className="w-full h-full" />
          </div>
        </div>
      </div>
    </div>
  );
 }