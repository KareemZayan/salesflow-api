import { TaskResponseDto } from './dto/task-response.dto';
import { TaskRecord } from './tasks.repository';
import { isOverdue } from './tasks.constants';

// The one place a task record becomes its API shape. `now` is the request's single clock reading,
// the same one the `?overdue` filter used, so the field and the filter cannot disagree.
export function toTaskResponse(task: TaskRecord, now: Date): TaskResponseDto {
  return { ...task, isOverdue: isOverdue(task, now) };
}
