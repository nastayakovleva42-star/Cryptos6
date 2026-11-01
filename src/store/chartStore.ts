import { create } from 'zustand';

interface ChartState {
  symbol: string;
  interval: string;
  trackedSymbols: string[];
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  toggleTrackedSymbol: (symbol: string) => void;
  loadState: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  symbol: 'BTCUSDT',
  interval: '1h',
  trackedSymbols: ['BTCUSDT'],
  
  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  
  toggleTrackedSymbol: (symbol) => set((state) => ({
    trackedSymbols: state.trackedSymbols.includes(symbol)
      ? state.trackedSymbols.filter((s) => s !== symbol)
      : [...state.trackedSymbols, symbol]
  })),
  
  loadState: () => {
    const savedSymbol = localStorage.getItem('chartSymbol');
    const savedInterval = localStorage.getItem('chartInterval');
    if (savedSymbol) set({ symbol: savedSymbol });
    if (savedInterval) set({ interval: savedInterval });
  },
}));