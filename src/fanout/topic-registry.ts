/**
 * Relación tópico -> conexiones (RF-5), con dos índices para que cada operación cueste lo mínimo:
 * - alta y baja de un par (tópico, conexión): O(1);
 * - baja de una conexión: O(tópicos de esa conexión), acotado por MAX_TOPICS_PER_CONNECTION;
 * - recorrido de un tópico: O(suscriptores de ese tópico), sin importar el total de la instancia.
 */
export class TopicRegistry<Connection extends object, Topic extends string = string> {
  private readonly subscribersByTopic = new Map<Topic, Set<Connection>>();
  private readonly topicsByConnection = new Map<Connection, Set<Topic>>();

  /** Devuelve `true` si es el primer suscriptor local: hay que suscribirse en el backplane. */
  add(connection: Connection, topic: Topic): boolean {
    let subscribers = this.subscribersByTopic.get(topic);
    const isFirstSubscriber = subscribers === undefined;
    if (!subscribers) {
      subscribers = new Set();
      this.subscribersByTopic.set(topic, subscribers);
    }
    subscribers.add(connection);

    let topics = this.topicsByConnection.get(connection);
    if (!topics) {
      topics = new Set();
      this.topicsByConnection.set(connection, topics);
    }
    topics.add(topic);
    return isFirstSubscriber;
  }

  /** Devuelve los tópicos que quedaron sin suscriptores locales: hay que soltarlos del backplane. */
  removeConnection(connection: Connection): Topic[] {
    const emptied: Topic[] = [];
    for (const topic of this.topicsByConnection.get(connection) ?? []) {
      const subscribers = this.subscribersByTopic.get(topic);
      subscribers?.delete(connection);
      if (subscribers?.size === 0) {
        this.subscribersByTopic.delete(topic);
        emptied.push(topic);
      }
    }
    this.topicsByConnection.delete(connection);
    return emptied;
  }

  subscribers(topic: Topic): ReadonlySet<Connection> {
    return this.subscribersByTopic.get(topic) ?? EMPTY_SET;
  }

  hasSubscribers = (topic: Topic) => this.subscribersByTopic.has(topic);

  connections = () => this.topicsByConnection.keys();

  get connectionCount() {
    return this.topicsByConnection.size;
  }

  get topicCount() {
    return this.subscribersByTopic.size;
  }
}

const EMPTY_SET: ReadonlySet<never> = new Set();
