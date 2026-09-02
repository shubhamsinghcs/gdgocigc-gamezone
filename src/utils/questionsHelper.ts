import { Question } from '../types';
import { questionsData } from '../data/questions';

export function getActiveQuestions(gameStateQuestions?: Question[]): Question[] {
  if (gameStateQuestions && Array.isArray(gameStateQuestions) && gameStateQuestions.length > 0) {
    return gameStateQuestions;
  }
  return questionsData;
}
