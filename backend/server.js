import { clerkMiddleware } from '@clerk/express'
import express from 'express'
import cors from 'cors'
import { connectDB } from './config/db.js'
import dotenv from "dotenv";
dotenv.config();

import { createProxyMiddleware } from 'http-proxy-middleware'       
const app = express()
const port = 4000;

// middlerware
app.use(cors())
app.use(clerkMiddleware())
app.use(express.urlencoded({limit: "20mb", extended: true})); 


//DB
connectDB();

//Routes 
app.get('/', (req, res) => {
    res.json({message: 'Hello from the backend!'})
})
app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
})