/** Make database rows safe to pass from server to client components. */
export const plain = (v) => JSON.parse(JSON.stringify(v));
