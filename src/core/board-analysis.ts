import { HEIGHT, WIDTH, type Cell } from './engine.js';
import type { Well } from './types.js';

/** Locked-board geometry shared by current observations and landing previews. */
export function boardMetrics(board: Cell[][]) {
  const heights = Array.from({ length: WIDTH }, (_, x) => {
    const top = board.findIndex((row) => row[x] !== null);
    return top < 0 ? 0 : HEIGHT - top;
  });
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    for (let y = HEIGHT - heights[x]; y < HEIGHT; y++) {
      if (board[y][x] === null) holes++;
    }
  }
  const wells: Well[] = [];
  for (let column = 0; column < WIDTH; column++) {
    const depth =
      Math.min(heights[column - 1] ?? HEIGHT, heights[column + 1] ?? HEIGHT) - heights[column];
    if (depth <= 0) continue;
    // Only the shaft above the column's highest cell is open from the top.
    // Covered gaps must never be presented as accessible attack setups.
    const floor = HEIGHT - heights[column];
    let readyRows = 0;
    let filledCells = 0;
    for (let y = Math.max(0, floor - 4); y < floor; y++) {
      const filled = board[y].filter((cell, x) => x !== column && cell !== null).length;
      filledCells += filled;
      if (filled === WIDTH - 1) readyRows++;
    }
    wells.push({
      column,
      depth,
      ready_rows: readyRows,
      filled_cells: filledCells,
    });
  }
  return {
    holes,
    max_height: Math.max(...heights),
    aggregate_height: heights.reduce((sum, height) => sum + height, 0),
    bumpiness: heights.slice(1).reduce((sum, height, x) => sum + Math.abs(height - heights[x]), 0),
    wells,
  };
}
