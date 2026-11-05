export interface EvalTask {
  name: string;
  brief: string;
  target: string;
  files: Record<string, string>;
  expect?: {
    maxWarnings?: number;
    stillFrame?: number;
    requireContent?: boolean;
  };
}

export const TASKS: EvalTask[];

export function findTask(name: string): EvalTask | undefined;
