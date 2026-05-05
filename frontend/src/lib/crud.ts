export function makeCrud<T extends { id: string }, CreateData, UpdateData>(
  apiCalls: {
    create: (data: CreateData) => Promise<T>;
    update: (id: string, data: UpdateData) => Promise<T>;
    delete: (id: string) => Promise<void>;
  },
  getList: () => T[],
  setList: (v: T[]) => void,
) {
  return {
    async create(data: CreateData): Promise<T> {
      const item = await apiCalls.create(data);
      setList([...getList(), item]);
      return item;
    },
    async update(id: string, data: UpdateData): Promise<T> {
      const item = await apiCalls.update(id, data);
      setList(getList().map((x): T => x.id === id ? item : x));
      return item;
    },
    async remove(id: string): Promise<void> {
      await apiCalls.delete(id);
      setList(getList().filter(x => x.id !== id));
    },
  };
}
