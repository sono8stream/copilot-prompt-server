// Simple Task Queue Manager
class TaskQueue {
    constructor(concurrency = 1) {
        this.queue = [];
        this.running = 0;
        this.concurrency = concurrency;
        this.onTaskComplete = null;
        this.onTaskStart = null;
    }

    enqueue(task) {
        const taskId = Date.now() + Math.random().toString(36).substr(2, 9);
        const queuedTask = {
            id: taskId,
            task: task,
            status: 'queued',
            createdAt: new Date(),
            result: null
        };

        this.queue.push(queuedTask);

        setImmediate(() => this.process());
        return taskId;
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }

        this.running++;
        const queuedTask = this.queue.shift();
        queuedTask.status = 'running';

        // Call onTaskStart after status is set to running
        if (this.onTaskStart) {
            this.onTaskStart(queuedTask);
        }

        try {
            const result = await queuedTask.task();
            queuedTask.status = 'completed';
            queuedTask.result = result;
        } catch (error) {
            queuedTask.status = 'failed';
            queuedTask.result = { error: error.message };
        }

        // Decrement running count BEFORE calling onTaskComplete
        this.running--;

        if (this.onTaskComplete) {
            this.onTaskComplete(queuedTask);
        }

        // Process next task
        if (this.queue.length > 0) {
            setImmediate(() => this.process());
        }
    }

    getStatus() {
        return {
            running: this.running,
            queued: this.queue.length,
            concurrency: this.concurrency
        };
    }
}

module.exports = TaskQueue;
