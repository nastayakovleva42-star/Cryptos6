import { useState } from 'react';

export interface Drawing {
  id: string;
  type: string;
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  fixed?: boolean; // true if converted to chart coordinates (time/price)
  interval?: string; // timeframe when drawing was created
  symbol?: string; // symbol when drawing was created
}

interface DrawingToolsProps {
  activeTool: string;
  onToolSelect: (tool: string) => void;
  isDrawingMode: boolean;
  onToggleDrawingMode: () => void;
  color: string;
  onColorChange: (color: string) => void;
  lineWidth: number;
  onLineWidthChange: (width: number) => void;
  drawings: Drawing[];
  onDeleteDrawing: (id: string) => void;
  onClearAll: () => void;
  selectedDrawingId: string | null;
  onSelectDrawing: (id: string | null) => void;
  isRulerMode: boolean;
  onToggleRulerMode: () => void;
}

const TOOLS = [
  { id: 'cursor', icon: '🖱️', label: 'Курсор (выбор)' },
  { id: 'hline', icon: '➖', label: 'Горизонтальная линия' },
  { id: 'vline', icon: '📏', label: 'Вертикальная линия' },
  { id: 'line', icon: '📐', label: 'Произвольная линия' },
  { id: 'ray', icon: '↗️', label: 'Луч' },
  { id: 'fib', icon: '🔢', label: 'Уровни Фибоначчи' },
  { id: 'rect', icon: '⬜', label: 'Прямоугольник' },
  { id: 'channel', icon: '📊', label: 'Параллельный канал' },
];

const COLORS = ['#2962ff', '#e91e63', '#ff9800', '#4caf50', '#9c27b0', '#00bcd4', '#ff5722', '#ffffff'];

export function DrawingTools({
  activeTool,
  onToolSelect,
  isDrawingMode,
  onToggleDrawingMode,
  color,
  onColorChange,
  lineWidth,
  onLineWidthChange,
  drawings,
  onDeleteDrawing,
  onClearAll,
  selectedDrawingId,
  onSelectDrawing,
  isRulerMode,
  onToggleRulerMode,
}: DrawingToolsProps) {
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);

  const selectedTool = TOOLS.find(t => t.id === activeTool);

  return (
    <div className="w-12 bg-[#131722] border-r border-[#2a2e39] flex flex-col items-center py-2 gap-1 shrink-0">
      {/* Drawing Mode Toggle */}
      <button
        onClick={onToggleDrawingMode}
        className={`w-10 h-10 flex items-center justify-center rounded text-sm transition-colors mb-2 ${
          isDrawingMode ? 'bg-green-600 shadow-lg shadow-green-600/30' : 'bg-[#2a2e39] hover:bg-[#363a45]'
        }`}
        title={isDrawingMode ? 'Режим рисования ВКЛ' : 'Режим рисования ВЫКЛ'}
      >
        {isDrawingMode ? '✏️' : '🖱️'}
      </button>

      {isDrawingMode && (
        <>
          {/* Tool Selector Dropdown */}
          <div className="relative w-full">
            <button
              onClick={() => setIsToolMenuOpen(!isToolMenuOpen)}
              className="w-10 h-10 flex items-center justify-center rounded text-sm bg-blue-600 hover:bg-blue-700 transition-colors"
              title={selectedTool?.label || 'Выбрать инструмент'}
            >
              {selectedTool?.icon || '📏'}
            </button>

            {isToolMenuOpen && (
              <div className="absolute left-full top-0 ml-2 bg-[#1e222d] border border-[#2a2e39] rounded-lg shadow-xl z-50 min-w-[180px]">
                <div className="py-1">
                  {TOOLS.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => {
                        onToolSelect(tool.id);
                        setIsToolMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-[#2a2e39] transition-colors flex items-center gap-2 ${
                        activeTool === tool.id ? 'bg-blue-600/20 text-blue-400' : ''
                      }`}
                    >
                      <span className="text-lg">{tool.icon}</span>
                      <span>{tool.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Ruler Tool Button */}
          <button
            onClick={onToggleRulerMode}
            className={`w-10 h-10 flex items-center justify-center rounded text-sm transition-colors ${
              isRulerMode ? 'bg-orange-600 shadow-lg shadow-orange-600/30' : 'bg-[#2a2e39] hover:bg-[#363a45]'
            }`}
            title={isRulerMode ? 'Линейка ВКЛ' : 'Линейка'}
          >
            📏
          </button>

          <div className="w-8 h-px bg-[#2a2e39] my-2" />

          {/* Color picker */}
          <div className="flex flex-col gap-1 items-center">
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => onColorChange(c)}
                className={`w-5 h-5 rounded-full border-2 transition-transform ${color === c ? 'border-white scale-125' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="w-8 h-px bg-[#2a2e39] my-2" />

          {/* Line width */}
          <div className="flex flex-col items-center gap-1" title="Толщина линии">
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={lineWidth}
              onChange={(e) => onLineWidthChange(Number(e.target.value))}
              className="w-10 accent-blue-500 cursor-pointer"
            />
            <span className="text-[10px] text-gray-400">{lineWidth}px</span>
          </div>

          <div className="w-8 h-px bg-[#2a2e39] my-2" />

          {/* Drawings list */}
          {drawings.length > 0 && (
            <>
              <div className="text-[10px] text-gray-400 mb-1">{drawings.length} рис.</div>
              <button
                onClick={onClearAll}
                className="w-10 h-8 flex items-center justify-center rounded text-xs hover:bg-red-600/20 hover:text-red-400 transition-colors mt-1"
                title="Удалить все"
              >
                🗑️
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
