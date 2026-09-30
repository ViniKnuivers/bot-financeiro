import { formatMonthShort } from '../lib/dates.js';
import { formatCents } from '../lib/money.js';
import type { GoalProgress } from '../modules/goals/goal.service.js';
import { progressBar } from './replies.js';

/** Uma meta no /metas: barra, quanto já tem e quanto guardar por mês. */
export function formatGoal(progress: GoalProgress): string {
  const { goal, savedCents, percent } = progress;
  const header = `🎯 ${goal.name}: ${formatCents(savedCents)} de ${formatCents(goal.targetCents)} (${String(percent)}%)`;
  return [header, progressBar(percent), goalStatusLine(progress)].join('\n');
}

function goalStatusLine(progress: GoalProgress): string {
  const { goal, remainingCents, perMonthCents, overdue, reached } = progress;
  if (reached) return '🎉 Meta alcançada!';
  const remaining = `Faltam ${formatCents(remainingCents)}`;
  if (!goal.deadline) return `${remaining} · sem prazo`;
  const deadline = formatMonthShort(goal.deadline);
  if (overdue) return `${remaining} · o prazo (${deadline}) já passou`;
  return `${remaining} · guarde ${formatCents(perMonthCents ?? 0)}/mês até ${deadline}`;
}

/** Linha curta depois de um aporte ou resgate (e a comemoração, na primeira vez). */
export function formatGoalAfterContribution(progress: GoalProgress, justReached: boolean): string {
  const { goal, savedCents, percent } = progress;
  if (justReached) {
    return `🎉 Você bateu a meta ${goal.name}: ${formatCents(savedCents)} de ${formatCents(goal.targetCents)}! Parabéns!`;
  }
  return `🎯 Meta ${goal.name}: ${formatCents(savedCents)} de ${formatCents(goal.targetCents)} (${String(percent)}%)`;
}

/** Linha compacta para o resumo semanal. */
export function formatGoalShort(progress: GoalProgress): string {
  const { goal, percent, perMonthCents, reached } = progress;
  if (reached) return `🎯 ${goal.name}: alcançada 🎉`;
  const pace =
    perMonthCents !== null && goal.deadline
      ? ` · guarde ${formatCents(perMonthCents)}/mês até ${formatMonthShort(goal.deadline)}`
      : '';
  return `🎯 ${goal.name}: ${String(percent)}%${pace}`;
}
