// services/CloudTasksQueue.js
import { CloudTasksClient } from '@google-cloud/tasks';


class CloudTasksQueue {
  constructor() {
    this.client = new CloudTasksClient();
    this.project = process.env.GOOGLE_CLOUD_PROJECT || 'vaulted-bivouac-417511';
    this.location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    this.serviceUrl = process.env.CLOUD_RUN_SERVICE_URL || 'https://postgen-xxxxx-uc.a.run.app';
  }

  async createQueue(queueName) {
    const parent = this.client.locationPath(this.project, this.location);
    
    try {
      const [queue] = await this.client.createQueue({
        parent,
        queue: {
          name: this.client.queuePath(this.project, this.location, queueName),
          rateLimits: {
            maxDispatchesPerSecond: 1,
            maxConcurrentDispatches: 1,
          },
          retryConfig: {
            maxAttempts: 3,
            maxRetryDuration: { seconds: 3600 }, // 1 hour
          },
        },
      });
      console.log(`Created queue ${queue.name}`);
      return queue;
    } catch (error) {
      if (error.code === 6) { // ALREADY_EXISTS
        console.log(`Queue ${queueName} already exists`);
      } else {
        throw error;
      }
    }
  }

  async addPostTask(postData, scheduleTime = null) {
    const queuePath = this.client.queuePath(
      this.project, 
      this.location, 
      'social-posts'
    );
    
    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: `${this.serviceUrl}/api/tasks/publish-post`,
        headers: {
          'Content-Type': 'application/json',
        },
        body: Buffer.from(JSON.stringify({
          ...postData,
          taskId: `task-${Date.now()}`
        })).toString('base64'),
        oidcToken: {
          serviceAccountEmail: `postgen-sa@${this.project}.iam.gserviceaccount.com`,
        },
      },
    };
    
    if (scheduleTime) {
      task.scheduleTime = {
        seconds: Math.floor(scheduleTime.getTime() / 1000),
      };
    }
    
    try {
      const [response] = await this.client.createTask({ 
        parent: queuePath, 
        task 
      });
      console.log(`Created task ${response.name}`);
      return response;
    } catch (error) {
      console.error('Error creating task:', error);
      throw error;
    }
  }
}

export default CloudTasksQueue;