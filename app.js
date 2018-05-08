import { CronJob } from 'cron';
import { app, uuid } from 'mu';
import {
  addPackage,
  createMetadata,
  createZipFile,
  cleanup,
  isRunning,
  updateInternalReportStatus,
  fetchReportsToBePackaged,
  fetchFilesForReport,
  STATUS_PROCESSING,
  STATUS_PACKAGED
} from './support';
import request from 'request';

/** Schedule export cron job */
const cronFrequency = process.env.PACKAGE_CRON_PATTERN || '*/30 * * * * *';
const FILES_PER_REPORT = 2 ;

cleanup();

new CronJob(cronFrequency, function() {
  console.log(`packaging triggered by cron job at ${new Date().toISOString()}`);
  request.post('http://localhost/package-bbcdr-reports/');
}, null, true);


app.post('/package-bbcdr-reports/', async function( req, res ) {
  try {
    if (await isRunning())
      return res.status(503).end();
    const reports = await fetchReportsToBePackaged();
    res.status(202).send({status:202, title: 'processing'});
    await Promise.all(reports.map( async (report) => {
      await updateInternalReportStatus(report.report, STATUS_PROCESSING);
      const files = await fetchFilesForReport(report.report);
      if (files.length === FILES_PER_REPORT) {
        const borderel = await createMetadata(report, files);
        const zipUUID = uuid();
        const zipFile = await createZipFile(zipUUID, files, borderel);
        await addPackage(report.report, zipFile, zipUUID);
        await updateInternalReportStatus(report.report, STATUS_PACKAGED);
        console.log(`packaged report ${report.id}`);
      }
    }));
    console.log('finished processing');
  }
  catch(e) {
    console.log(e);
  }
});
