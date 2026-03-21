// lib/db.js — MongoDB: conexão compatível com serverless (Vercel)

import { MongoClient, ObjectId } from 'mongodb';

const URI = process.env.MONGODB_URI;
const options = {};

let client;
let clientPromise;

if (!global._mongoClientPromise) {
    client = new MongoClient(URI, options);
    global._mongoClientPromise = client.connect();
}
clientPromise = global._mongoClientPromise;

export async function db() {
    const c = await clientPromise;
    return c.db('codental_monitor');
}